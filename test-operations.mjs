import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const port=37834,base='http://127.0.0.1:'+port,wait=ms=>new Promise(r=>setTimeout(r,ms));
const child=spawn(process.execPath,[fileURLToPath(new URL('./bridge-server.mjs',import.meta.url))],{env:{...process.env,BRIDGE_PORT:String(port),BRIDGE_READ_TIMEOUT_MS:'80',BRIDGE_WRITE_TIMEOUT_MS:'400'},stdio:['ignore','ignore','inherit'],windowsHide:true});
const post=async(path,p)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});return {status:r.status,...await r.json()};};
const next=async id=>(await fetch(base+'/next?connectionId='+id)).json();
try{
 for(let i=0;i<50;i++){try{if((await(await fetch(base+'/health')).json()).ok)break;}catch{}await wait(25);}
 const connectionId=(await post('/hello',{protocolVersion:2,document:{bridgeVersion:9,pages:[{id:'p',name:'Page'}]}})).connectionId;
 const clientId=(await post('/clients/register',{name:'Reliability fixture',aiName:'Codex'})).clientId;
 const bindingId=(await post('/bindings',{connectionId,clientId,pageId:'p'})).binding.bindingId,route={connectionId,clientId,bindingId};
 const query=async key=>(await fetch(base+'/operations?'+new URLSearchParams({connectionId,clientId,idempotencyKey:key}))).json();
 const body={...route,type:'update-node',nodeId:'node',props:{x:1},idempotencyKey:'update-1'};
 const first=post('/command',body),dispatch=await next(connectionId);assert.equal(dispatch.command.type,'update-node');
 const duplicate=await post('/command',body);assert.equal(duplicate.status,202);assert.equal(duplicate.operation.requestId,dispatch.requestId);
 assert.equal((await query('update-1')).operation.state,'running');
 assert.equal((await post('/command',{...body,props:{x:2}})).status,409);
 assert.equal((await first).status,504);assert.equal((await query('update-1')).operation.state,'uncertain');
 assert.equal((await post('/command',body)).operation.requestId,dispatch.requestId);
 assert.equal((await post('/command',{...route,type:'undo-operation',operationId:'unknown'})).status,409);
 const result={id:'node',operationId:dispatch.requestId,diff:[{id:'node',properties:[{property:'x',before:0,after:1}]}]};
 await post('/result',{connectionId,requestId:dispatch.requestId,ok:true,result});
 const late=await query('update-1');assert.equal(late.operation.state,'succeeded');assert.equal(late.operation.result.result.id,'node');
 const replay=await post('/command',body);assert.equal(replay.status,200);assert.equal(replay.duplicate,true);assert.deepEqual(replay.result,result);
 assert.equal((await(await fetch(base+'/health')).json()).connections[0].queueLength,0);
 const stranger=(await post('/clients/register',{name:'Stranger',aiName:'Other'})).clientId;assert.equal((await fetch(base+'/operations?'+new URLSearchParams({connectionId,clientId:stranger,requestId:dispatch.requestId}))).status,404);
 assert.equal((await post('/command',{...route,type:'batch',commands:[{type:'create-variable-collection',name:'Tokens'}]})).status,409);
 const pending=post('/command',{...route,type:'create-kpi-card',key:'card',idempotencyKey:'card-1'});const card=await next(connectionId);await post('/result',{connectionId,requestId:card.requestId,ok:false,error:'Bad card',details:{rollback:{ok:true},failedStep:'card'}});assert.equal((await pending).details.rollback.ok,true);const failedReplay=await post('/command',{...route,type:'create-kpi-card',key:'card',idempotencyKey:'card-1'});assert.equal(failedReplay.ok,false);assert.equal(failedReplay.duplicate,true);
 console.log('PASS reliability server: one dispatch per key, concurrent retry, payload conflict, update write timeout, uncertain query, late result query, successful/failed replay, query ownership, nested file-scope guard, structured rollback details');
}finally{child.kill();}
