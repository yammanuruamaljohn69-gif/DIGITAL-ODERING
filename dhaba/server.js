const express=require('express'),fs=require('fs'),path=require('path');
const app=express();app.use(express.json({limit:'20kb'}));
const PIN=process.env.KITCHEN_PIN||'1234';           // change this!
const DB=process.env.DB_FILE||path.join(__dirname,'orders.json');
const menu=JSON.parse(fs.readFileSync(path.join(__dirname,'menu.json')));
let orders=[];try{orders=JSON.parse(fs.readFileSync(DB))}catch(e){}
const save=()=>fs.writeFile(DB,JSON.stringify(orders),()=>{});
const clients=new Set(),ping=()=>clients.forEach(r=>r.write('data: x\n\n'));
const auth=(q,r,n)=>q.get('x-pin')===PIN?n():r.status(401).json({error:'pin'});

app.get('/api/menu',(q,r)=>r.json(menu));
app.get('/api/events',(q,r)=>{r.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});r.flushHeaders();r.write('retry: 3000\n\n');clients.add(r);q.on('close',()=>clients.delete(r))});
app.get('/api/orders',(q,r)=>r.json(orders.filter(o=>o.table===+q.query.table)));   // customer: own table only
app.get('/api/kitchen',auth,(q,r)=>r.json(orders));

app.post('/api/orders',(q,r)=>{
  const t=+q.body.table,lines=Array.isArray(q.body.items)?q.body.items.slice(0,40):[],items=[];
  if(!(t>=1&&t<=99))return r.status(400).json({error:'table'});
  for(const l of lines){const m=menu.find(x=>x.id===l.id),n=Math.floor(+l.q);if(m&&n>=1&&n<=20)items.push({n:m.name,p:m.price,q:n})} // price always from server
  if(!items.length)return r.status(400).json({error:'empty'});
  const sig=JSON.stringify(items),dup=orders.find(o=>o.table===t&&o.sig===sig&&Date.now()-o.t<15000);
  if(dup)return r.json(dup);                         // duplicate tap/scan within 15s is ignored
  const o={id:Date.now().toString(36)+Math.random().toString(36).slice(2,5),table:t,items,sig,status:'New',t:Date.now()};
  orders.push(o);save();ping();r.json(o)});

app.post('/api/orders/:id/next',auth,(q,r)=>{
  const o=orders.find(x=>x.id===q.params.id);if(!o)return r.sendStatus(404);
  o.status=o.status==='New'?'Cooking':'Served';save();ping();r.json(o)});
app.post('/api/tables/:n/close',auth,(q,r)=>{orders=orders.filter(o=>o.table!==+q.params.n);save();ping();r.json({ok:1})});

app.use(express.static(path.join(__dirname,'public')));
app.listen(process.env.PORT||3000,()=>console.log('Dhaba orders running on port '+(process.env.PORT||3000)));
