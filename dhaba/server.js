const express=require('express'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const app=express();app.set('trust proxy',1);app.use(express.json({limit:'400kb'}));
const AP=process.env.ADMIN_PIN;                                                  // one PIN for admin AND kitchen; unset => both refuse to work
const DB=process.env.DB_FILE||path.join(__dirname,'orders.json'),SF=DB.replace(/\.json$/,'')+'.state.json';
const hs=s=>crypto.createHash('sha256').update(String(s||'')).digest(),eq=(a,b)=>!!b&&crypto.timingSafeEqual(hs(a),hs(b));
const aauth=(q,r,n)=>!AP?r.status(503).json({error:'ADMIN_PIN not set'}):eq(q.get('x-pin'),AP)?n():r.status(401).json({error:'pin'});
const kauth=aauth;                                                             // kitchen uses the admin PIN now
const pool=process.env.DATABASE_URL?new (require('pg').Pool)({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:3}):null;
const st={};                                                                    // per-key serialized saves (Postgres) or file writes
function put(k,fn,file){if(!pool)return fs.writeFile(file,JSON.stringify(fn()),()=>{});
  const s=st[k]=st[k]||{};if(s.run){s.again=1;return}s.run=1;
  pool.query("insert into kv(k,v) values($1,$2) on conflict(k) do update set v=excluded.v",[k,JSON.stringify(fn())]).catch(e=>console.error('save failed:',e.message)).finally(()=>{s.run=0;if(s.again){s.again=0;put(k,fn,file)}})}
const get=async(k,file)=>{if(pool){const r=await pool.query("select v from kv where k=$1",[k]);return r.rows[0]&&r.rows[0].v}try{return JSON.parse(fs.readFileSync(file))}catch(e){}};
let orders=[],S=null,IM={},calls=[];                                             // calls = open 'call waiter' requests (in memory)
const saveO=()=>put('orders',()=>orders,DB),saveS=()=>put('state',()=>S,SF),saveI=()=>put('img',()=>IM,SF+'.img');
const cl=(s,n)=>String(s==null?'':s).replace(/[<>]/g,'').trim().slice(0,n);
const pub=m=>({id:m.id,cat:m.cat,name:m.name,price:m.price,veg:m.veg,out:!!m.out,img:IM[m.id]?(m.iv||1):0});
const clients=new Set(),ping=()=>clients.forEach(r=>r.write('data: x\n\n'));
function seed(){const base=JSON.parse(fs.readFileSync(path.join(__dirname,'menu.json'))),nonveg=/chicken|mutton|egg|fish|prawn|kebab|keema|liver|lollipop|wings|tangdi|crab|beef|pomfret/i;
  S={menu:[],cats:[],waiters:[],tmap:{},tables:10,next:1};
  base.forEach(m=>{S.menu.push({id:m.id,cat:m.cat,name:m.name,price:m.price,veg:!nonveg.test(m.name)&&!nonveg.test(m.cat)});if(!S.cats.includes(m.cat))S.cats.push(m.cat);S.next=Math.max(S.next,m.id+1)});
  S.cats.push('Water & Soft Drinks');[['Water Bottle',20],['Thums Up',45],['Pepsi',45],['Sprite',45],['Mirinda',45],['7UP',45],['Limca',45]].forEach(d=>S.menu.push({id:S.next++,cat:'Water & Soft Drinks',name:d[0],price:d[1],veg:true}))}

app.get('/healthz',(q,r)=>r.send('ok'));                                         // keep-alive target (no database work)
app.get('/api/menu',(q,r)=>r.json({cats:S.cats,items:S.menu.filter(m=>!m.hide).map(pub),tmap:S.tmap,tables:S.tables}));
app.get('/img/:id',(q,r)=>{const d=IM[+q.params.id],m=d&&d.match(/^data:image\/jpeg;base64,(.+)$/);if(!m)return r.sendStatus(404);r.set({'Content-Type':'image/jpeg','Cache-Control':'public,max-age=86400'}).send(Buffer.from(m[1],'base64'))});
app.get('/api/events',(q,r)=>{r.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});r.flushHeaders();r.write('retry: 3000\n\n');clients.add(r);q.on('close',()=>clients.delete(r))});
app.get('/api/orders',(q,r)=>r.json(orders.filter(o=>o.table===+q.query.table)));
app.get('/api/kitchen',kauth,(q,r)=>r.json(orders));

const rl={},rip={};
setInterval(()=>{const n=Date.now();for(const o of [rl,rip])for(const k in o){o[k]=o[k].filter(x=>n-x<60000);if(!o[k].length)delete o[k]}},60000).unref();
// sliding-window limiter: returns true if the key already used up `max` hits in the last `win` ms
const limited=(box,key,max,win)=>{const n=Date.now(),w=(box[key]=(box[key]||[]).filter(x=>n-x<win));if(w.length>=max)return true;w.push(n);return false};
const validTable=t=>Number.isInteger(t)&&t>=1&&t<=S.tables;
app.post('/api/orders',(q,r)=>{
  const t=+q.body.table,lines=Array.isArray(q.body.items)?q.body.items.slice(0,40):[],items=[],now=Date.now();
  if(!validTable(t))return r.status(400).json({error:'table'});                // table must exist (set in Admin)
  if(limited(rip,q.ip,30,60000))return r.status(429).json({error:'slow down'}); // per-phone/IP limit
  if(limited(rl,t,5,60000))return r.status(429).json({error:'slow down'});      // per-table limit: 5 orders a minute
  for(const l of lines){const m=S.menu.find(x=>x.id===+l.id),n=Math.floor(+l.q);if(!m||m.hide)return r.status(400).json({error:'unavailable',id:+l.id});
    if(m.out)return r.status(409).json({error:'out',id:m.id,name:m.name});if(n>=1&&n<=20)items.push({n:m.name,p:m.price,q:n})}   // name+price snapshot, price only from server
  if(!items.length)return r.status(400).json({error:'empty'});
  const sig=JSON.stringify(items),dup=orders.find(o=>o.table===t&&o.sig===sig&&now-o.t<15000);if(dup)return r.json(dup);
  const o={id:now.toString(36)+Math.random().toString(36).slice(2,5),table:t,items,sig,waiter:S.tmap[t]||'',status:'New',t:now};
  orders.push(o);saveO();ping();r.json(o)});
// ---- call waiter ----
const rc={};
app.get('/api/call',(q,r)=>r.json({open:calls.some(c=>c.table===+q.query.table)}));
app.post('/api/call',(q,r)=>{const t=+q.body.table;
  if(!validTable(t))return r.status(400).json({error:'table'});
  if(limited(rip,'c'+q.ip,20,60000)||limited(rc,t,3,60000))return r.status(429).json({error:'slow down'});
  let c=calls.find(x=>x.table===t);if(!c){c={id:Date.now().toString(36)+Math.random().toString(36).slice(2,5),table:t,waiter:S.tmap[t]||'',t:Date.now()};calls.push(c);ping()}
  r.json(c)});
app.get('/api/calls',kauth,(q,r)=>r.json(calls));
app.post('/api/calls/:id/done',kauth,(q,r)=>{calls=calls.filter(c=>c.id!==q.params.id);ping();r.json({ok:1})});
app.post('/api/orders/:id/next',kauth,(q,r)=>{const o=orders.find(x=>x.id===q.params.id);if(!o)return r.sendStatus(404);o.status=o.status==='New'?'Cooking':'Served';saveO();ping();r.json(o)});
app.post('/api/tables/:n/close',kauth,(q,r)=>{orders=orders.filter(o=>o.table!==+q.params.n);calls=calls.filter(c=>c.table!==+q.params.n);saveO();ping();r.json({ok:1})});

// ---- admin ----
app.get('/api/admin/state',aauth,(q,r)=>r.json({cats:S.cats,items:S.menu.map(m=>({...pub(m),hide:!!m.hide})),waiters:S.waiters,tmap:S.tmap,tables:S.tables}));
app.post('/api/admin/tables',aauth,(q,r)=>{const n=Math.floor(+q.body.n);if(!(n>=1&&n<=99))return r.status(400).json({error:'invalid'});S.tables=n;for(const k in S.tmap)if(+k>n)delete S.tmap[k];saveS();ping();r.json({tables:n})});
app.post('/api/admin/item',aauth,(q,r)=>{const b=q.body,name=cl(b.name,60),cat=cl(b.cat,40),price=Math.round(+b.price);
  if(!name||!cat||!(price>=0&&price<=99999))return r.status(400).json({error:'invalid'});
  let m=b.id&&S.menu.find(x=>x.id===+b.id);if(!m){m={id:S.next++};S.menu.push(m)}
  Object.assign(m,{name,cat,price,veg:!!b.veg,hide:!!b.hide,out:!!b.out});if(!S.cats.includes(cat))S.cats.push(cat);saveS();ping();r.json(pub(m))});
app.delete('/api/admin/item/:id',aauth,(q,r)=>{S.menu=S.menu.filter(m=>m.id!==+q.params.id);delete IM[+q.params.id];saveS();saveI();ping();r.json({ok:1})});
app.post('/api/admin/img/:id',aauth,(q,r)=>{const m=S.menu.find(x=>x.id===+q.params.id),d=q.body.data;
  if(!m||typeof d!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(d)||d.length>120000)return r.status(400).json({error:'image'});
  IM[m.id]=d;m.iv=(m.iv||0)+1;saveS();saveI();ping();r.json({ok:1})});
app.post('/api/admin/cat',aauth,(q,r)=>{const f=cl(q.body.from,40),t=cl(q.body.to,40);if(!f||!t)return r.sendStatus(400);S.menu.forEach(m=>{if(m.cat===f)m.cat=t});S.cats=[...new Set(S.cats.map(c=>c===f?t:c))];saveS();ping();r.json({ok:1})});
app.post('/api/admin/bulk',aauth,(q,r)=>{const {mode,dir,amount,cat,round,apply}=q.body,a=+amount,rd=[1,5,10].includes(+round)?+round:1;
  if(!(a>0&&a<=1000)||!['up','down'].includes(dir)||!['pct','rs'].includes(mode))return r.status(400).json({error:'invalid'});
  const sg=dir==='up'?1:-1,list=S.menu.filter(m=>!cat||m.cat===cat).map(m=>({id:m.id,name:m.name,old:m.price,nw:Math.max(0,Math.round((mode==='pct'?m.price*(1+sg*a/100):m.price+sg*a)/rd)*rd)}));
  if(apply===true){list.forEach(x=>{S.menu.find(m=>m.id===x.id).price=x.nw});saveS();ping()}r.json(list)});
app.post('/api/admin/waiters',aauth,(q,r)=>{const b=q.body;
  if(b.rename){const f=cl(b.rename.from,30),t=cl(b.rename.to,30);if(t&&S.waiters.includes(f)){S.waiters=S.waiters.map(w=>w===f?t:w);for(const k in S.tmap)if(S.tmap[k]===f)S.tmap[k]=t}}
  else{S.waiters=[...new Set((b.waiters||[]).map(w=>cl(w,30)).filter(Boolean))].slice(0,30);for(const k in S.tmap)if(!S.waiters.includes(S.tmap[k]))delete S.tmap[k]}
  saveS();ping();r.json({waiters:S.waiters,tmap:S.tmap})});
app.post('/api/admin/tmap',aauth,(q,r)=>{const t=+q.body.table,w=cl(q.body.waiter,30);if(!(t>=1&&t<=99)||(w&&!S.waiters.includes(w)))return r.sendStatus(400);
  if(w)S.tmap[t]=w;else delete S.tmap[t];saveS();ping();r.json(S.tmap)});

app.use(express.static(path.join(__dirname,'public')));
async function init(){
  if(pool)await pool.query("create table if not exists kv(k text primary key, v jsonb not null)");
  const o=await get('orders',DB);if(Array.isArray(o))orders=o;
  S=await get('state',SF);if(!S||!Array.isArray(S.menu)){seed();saveS()}
  if(!(S.tables>=1)){S.tables=10;saveS()}                                       // older saved menus have no table count yet
  IM=(await get('img',SF+'.img'))||{};
  console.log('Loaded '+orders.length+' orders, '+S.menu.length+' menu items');
  if(!AP)console.log('ADMIN_PIN not set: admin and kitchen are disabled');
  app.listen(process.env.PORT||3000,()=>console.log('Dhaba orders running on port '+(process.env.PORT||3000)));
  // Keep-alive: Render sets RENDER_EXTERNAL_URL. Ping our own public URL every 10 min so the free plan is less likely to sleep.
  // Set KEEPALIVE=off to disable. An outside monitor (UptimeRobot) is still the more reliable option.
  const ext=process.env.RENDER_EXTERNAL_URL;
  if(ext&&process.env.KEEPALIVE!=='off'&&typeof fetch==='function'){
    setInterval(()=>fetch(ext.replace(/\/$/,'')+'/healthz').catch(e=>console.log('keep-alive failed:',e.message)),10*60*1000).unref();
    console.log('Keep-alive ping on for '+ext);
  }
}
init().catch(e=>{console.error('startup failed:',e.message);process.exit(1)});
