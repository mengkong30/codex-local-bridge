import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const port=37833,base='http://127.0.0.1:'+port,root=fileURLToPath(new URL('.',import.meta.url));
const child=spawn(process.execPath,[root+'bridge-server.mjs'],{env:{...process.env,BRIDGE_PORT:String(port),BRIDGE_CONNECTION_TTL_MS:'1200',BRIDGE_READ_TIMEOUT_MS:'180',BRIDGE_WRITE_TIMEOUT_MS:'900'},stdio:['ignore','ignore','inherit'],windowsHide:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function post(path,p){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p),signal:AbortSignal.timeout(4000)});return {status:r.status,...await r.json()};}
async function health(){return (await fetch(base+'/health')).json();}
const doc=(fileName,modern=true)=>({fileName,bridgeVersion:modern?8:7,...(modern?{panelProtocol:1}:{}),pageId:'p1',pageName:'页面一',pages:[{id:'p1',name:'页面一'}]});
const hello=(document,connectionId)=>post('/hello',{protocolVersion:2,connectionId,document});
try{
 for(let i=0;i<40;i++){try{if((await health()).ok)break;}catch{}await delay(50);}
 const legacy=(await hello(doc('旧插件',false))).connectionId;
 assert.equal((await health()).hub.connectionId,null);
 const a=(await hello(doc('A'))).connectionId,b=(await hello(doc('B'))).connectionId;
 assert.equal((await health()).hub.connectionId,a);
 assert.equal((await post('/panel/promote',{connectionId:legacy})).status,409);
 const ca=(await post('/clients/register',{name:'任务 A',aiName:'Codex'})).clientId,cb=(await post('/clients/register',{name:'任务 B',aiName:'DeepSeek'})).clientId;
 const ba=(await post('/bindings',{clientId:ca,connectionId:a,pageId:'p1'})).binding,bb=(await post('/bindings',{clientId:cb,connectionId:b,pageId:'p1'})).binding;
 const snapshot=()=>health().then(s=>s.connections.flatMap(c=>c.bindings).map(b=>b.bindingId).sort());
 const original=await snapshot();
 // Display can transfer while a real request is executing. It must not alter routing.
 const waiting=fetch(base+'/next?connectionId='+b).then(r=>r.json());
 const response=post('/command',{clientId:cb,bindingId:bb.bindingId,type:'ping'});const command=await waiting;
 await post('/panel/promote',{connectionId:a,targetConnectionId:b});assert.equal((await health()).hub.connectionId,b);assert.deepEqual(await snapshot(),original);
 assert.equal((await post('/panel/release',{connectionId:b,targetConnectionId:b,bindingId:bb.bindingId})).status,409);
 assert.equal((await post('/panel/release',{connectionId:a,targetConnectionId:b,bindingId:bb.bindingId})).status,409);
 await post('/panel/compact',{connectionId:b});assert.equal((await health()).hub.connectionId,a);
 assert.equal((await response).status,504);
 await post('/panel/promote',{connectionId:b});assert.equal((await health()).hub.connectionId,b);assert.equal((await health()).connections.find(c=>c.connectionId===b).uncertain,true);
 await post('/result',{connectionId:b,requestId:command.requestId,ok:true,result:{pong:true}});
 assert.equal((await post('/panel/release',{connectionId:b,targetConnectionId:a,bindingId:ba.bindingId})).ok,true);
 assert.equal((await post('/panel/release',{connectionId:b,targetConnectionId:a,bindingId:bb.bindingId})).status,409);
 assert.equal((await post('/panel/promote',{connectionId:a,targetConnectionId:legacy})).status,409);
 // Simultaneous self-promotions converge to one authoritative hub revision.
 await Promise.all([post('/panel/promote',{connectionId:a}),post('/panel/promote',{connectionId:b})]);
 const as=await(await fetch(base+'/panel?connectionId='+a)).json(),bs=await(await fetch(base+'/panel?connectionId='+b)).json();
 assert.equal(as.hub.connectionId,bs.hub.connectionId);assert.equal(as.hub.revision,bs.hub.revision);assert.ok(as.hub.revision>0);
 await post('/panel/promote',{connectionId:b});
 // Keep A's worker alive while the current hub B disappears.
 const keep=setInterval(()=>hello(doc('A'),a).catch(()=>{}),250);
 await delay(1400);clearInterval(keep);
 const after=(await(await fetch(base+'/panel?connectionId='+a)).json());assert.equal(after.hub.connectionId,a);
 const offline=after.connections.find(c=>c.connectionId===b);assert.equal(offline.connected,false);assert.ok(offline.disconnectedAt);
 assert.equal((await post('/panel/promote',{connectionId:b})).status,409);
 assert.equal((await post('/panel/forget',{connectionId:a,targetConnectionId:a})).status,409);
 assert.equal((await post('/panel/forget',{connectionId:a,targetConnectionId:b})).ok,true);
 assert.equal((await(await fetch(base+'/panel?connectionId='+a)).json()).connections.some(c=>c.connectionId===b),false);
 assert.equal((await post('/panel/forget',{connectionId:a,targetConnectionId:b})).ok,true);
 const reborn=(await hello(doc('B'),b)).connectionId;assert.notEqual(reborn,b);assert.equal((await health()).hub.connectionId,a);
 assert.equal((await post('/command',{clientId:cb,bindingId:bb.bindingId,type:'ping'})).status,409);
 await post('/panel/compact',{connectionId:a});assert.equal((await health()).hub.connectionId,reborn);
 await post('/panel/compact',{connectionId:reborn});assert.equal((await health()).hub.connectionId,null);
 await post('/panel/promote',{connectionId:a});await post('/disconnect',{connectionId:a});
 assert.equal((await health()).hub.connectionId,null); // B explicitly chose compact; no forced promotion.
 console.log('PASS hub server: one hub, concurrent promotions, transfer during work/uncertainty, unchanged bindings, remote release guards, legacy compatibility, expiry failover, offline records, reconnect, all-compact mode');
}finally{child.kill();}
