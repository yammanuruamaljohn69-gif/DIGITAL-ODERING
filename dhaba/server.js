const express=require('express'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const app=express();app.use(express.json({limit:'400kb'}));
const KP=process.env.KITCHEN_PIN||'1234',AP=process.env.ADMIN_PIN;           // ADMIN_PIN unset => admin refuses to work
const DB=process.env.DB_FILE||path.join(__dirname,'orders.json'),SF=DB.replace(/\.json$/,'')+'.state.json';
const hs=s=>crypto.createHash('sha256').update(String(s||'')).digest(),eq=(a,b)=>!!b&&crypto.timingSafeEqual(hs(a),hs(b));
const kauth=(q,r,n)=>eq(q.get('x-pin'),KP)?n():r.status(401).json({error:'pin'});
const aauth=(q,r,n)=>!AP?r.status(503).json({error:'ADMIN_PIN not set'}):eq(q.get('x-pin'),AP)?n():r.status(401).json({error:'pin'});
const pool=process.env.DATABASE_URL?new (require('pg').Pool)({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:3}):null;
const st={};                                                                    // per-key serialized saves (Postgres) or file writes
function put(k,fn,file){if(!pool)return fs.writeFile(file,JSON.stringify(fn()),()=>{});
  const s=st[k]=st[k]||{};if(s.run){s.again=1;return}s.run=1;
  pool.query("insert into kv(k,v) values($1,$2) on conflict(k) do update set v=excluded.v",[k,JSON.stringify(fn())]).catch(e=>console.error('save failed:',e.message)).finally(()=>{s.run=0;if(s.again){s.again=0;put(k,fn,file)}})}
const get=async(k,file)=>{if(pool){const r=await pool.query("select v from kv where k=$1",[k]);return r.rows[0]&&r.rows[0].v}try{return JSON.parse(fs.readFileSync(file))}catch(e){}};
let orders=[],S=null,IM={};
const saveO=()=>put('orders',()=>orders,DB),saveS=()=>put('state',()=>S,SF),saveI=()=>put('img',()=>IM,SF+'.img');
const cl=(s,n)=>String(s==null?'':s).replace(/[<>]/g,'').trim().slice(0,n);
const pub=m=>({id:m.id,cat:m.cat,name:m.name,price:m.price,veg:m.veg,out:!!m.out,img:IM[m.id]?(m.iv||1):0});
const clients=new Set(),ping=()=>clients.forEach(r=>r.write('data: x\n\n'));
function seed(){const base=JSON.parse(fs.readFileSync(path.join(__dirname,'menu.json'))),nonveg=/chicken|mutton|egg|fish|prawn|kebab|keema|liver|lollipop|wings|tangdi|crab|beef|pomfret/i;
  S={menu:[],cats:[],waiters:[],tmap:{},next:1};
  base.forEach(m=>{S.menu.push({id:m.id,cat:m.cat,name:m.name,price:m.price,veg:!nonveg.test(m.name)&&!nonveg.test(m.cat)});if(!S.cats.includes(m.cat))S.cats.push(m.cat);S.next=Math.max(S.next,m.id+1)});
  S.cats.push('Water & Soft Drinks');[['Water Bottle',20],['Thums Up',45],['Pepsi',45],['Sprite',45],['Mirinda',45],['7UP',45],['Limca',45]].forEach(d=>S.menu.push({id:S.next++,cat:'Water & Soft Drinks',name:d[0],price:d[1],veg:true}))}

app.get('/api/menu',(q,r)=>r.json({cats:S.cats,items:S.menu.filter(m=>!m.hide).map(pub),tmap:S.tmap}));
app.get('/img/:id',(q,r)=>{const d=IM[+q.params.id],m=d&&d.match(/^data:image\/jpeg;base64,(.+)$/);if(!m)return r.sendStatus(404);r.set({'Content-Type':'image/jpeg','Cache-Control':'public,max-age=86400'}).send(Buffer.from(m[1],'base64'))});
app.get('/api/events',(q,r)=>{r.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});r.flushHeaders();r.write('retry: 3000\n\n');clients.add(r);q.on('close',()=>clients.delete(r))});
app.get('/api/orders',(q,r)=>r.json(orders.filter(o=>o.table===+q.query.table)));
app.get('/api/kitchen',kauth,(q,r)=>r.json(orders));

const rl={};
app.post('/api/orders',(q,r)=>{
  const t=+q.body.table,lines=Array.isArray(q.body.items)?q.body.items.slice(0,40):[],items=[];
  if(!(t>=1&&t<=99))return r.status(400).json({error:'table'});
  const now=Date.now(),w=(rl[t]=(rl[t]||[]).filter(x=>now-x<60000));if(w.length>=5)return r.status(429).json({error:'slow down'});
  for(const l of lines){const m=S.menu.find(x=>x.id===+l.id),n=Math.floor(+l.q);if(!m||m.hide)return r.status(400).json({error:'unavailable',id:+l.id});
    if(m.out)return r.status(409).json({error:'out',id:m.id,name:m.name});if(n>=1&&n<=20)items.push({n:m.name,p:m.price,q:n})}   // name+price snapshot, price only from server
  if(!items.length)return r.status(400).json({error:'empty'});
  const sig=JSON.stringify(items),dup=orders.find(o=>o.table===t&&o.sig===sig&&now-o.t<15000);if(dup)return r.json(dup);
  w.push(now);const o={id:now.toString(36)+Math.random().toString(36).slice(2,5),table:t,items,sig,waiter:S.tmap[t]||'',status:'New',t:now};
  orders.push(o);saveO();ping();r.json(o)});
app.post('/api/orders/:id/next',kauth,(q,r)=>{const o=orders.find(x=>x.id===q.params.id);if(!o)return r.sendStatus(404);o.status=o.status==='New'?'Cooking':'Served';saveO();ping();r.json(o)});
app.post('/api/tables/:n/close',kauth,(q,r)=>{orders=orders.filter(o=>o.table!==+q.params.n);saveO();ping();r.json({ok:1})});

// ---- admin ----
app.get('/api/admin/state',aauth,(q,r)=>r.json({cats:S.cats,items:S.menu.map(m=>({...pub(m),hide:!!m.hide})),waiters:S.waiters,tmap:S.tmap}));
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
  IM=(await get('img',SF+'.img'))||{};
  console.log('Loaded '+orders.length+' orders, '+S.menu.length+' menu items');
  if(!AP)console.log('ADMIN_PIN not set: admin panel disabled');
  app.listen(process.env.PORT||3000,()=>console.log('Dhaba orders running on port '+(process.env.PORT||3000)));
}
init().catch(e=>{console.error('startup failed:',e.message);process.exit(1)});
