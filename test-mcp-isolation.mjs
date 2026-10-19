import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('.',import.meta.url)),port=37830,base='http://localhost:'+port;
const env={...process.env,BRIDGE_PORT:String(port)};
const server=spawn(process.execPath,[root+'bridge-server.mjs'],{env,stdio:['ignore','ignore','inherit'],windowsHide:true});
const processes=[];
function mcp(){
 const child=spawn(process.execPath,[root+'mcp-server.mjs'],{env,stdio:['pipe','pipe','inherit'],windowsHide:true});processes.push(child);
 let buffer='',id=0;const pending=new Map();
 child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);pending.get(m.id)?.(m);pending.delete(m.id);}});
 const rpc=(method,params={})=>new Promise(resolve=>{const requestId=++id;pending.set(requestId,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');});
 return {rpc,call:async(name,args={})=>(await rpc('tools/call',{name,arguments:args})).result};
}
async function post(path,p){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});return r.json();}
const parse=r=>JSON.parse(r.content[0].text);
const timer=setTimeout(()=>{for(const p of processes)p.kill();server.kill();process.exit(1);},15000);
try{
 for(let i=0;i<40;i++){try{if((await(await fetch(base+'/health')).json()).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
 const connectionId=(await post('/hello',{protocolVersion:2,document:{fileName:'MCP fixture',bridgeVersion:9,pages:[{id:'p1',name:'桌面'},{id:'p2',name:'移动端'}]}})).connectionId;
 const a=mcp(),b=mcp();assert.equal((await a.rpc('initialize')).result.serverInfo.version,'0.8.1');
 const list=(await a.rpc('tools/list')).result.tools;assert.equal(list.length,17);
 assert.equal(list.find(t=>t.name==='local_figma_command').annotations.readOnlyHint,false);
 const aa=parse(await a.call('local_figma_bind',{connectionId,pageId:'p1',clientName:'桌面设计',aiName:'Codex'})).binding;
 const bb=parse(await b.call('local_figma_bind',{connectionId,pageId:'p2',clientName:'移动端设计',aiName:'DeepSeek'})).binding;
 assert.equal((await b.call('local_figma_command',{bindingId:aa.bindingId,command:{type:'ping'}})).isError,true);
 const pending=a.call('local_figma_command',{bindingId:aa.bindingId,command:{type:'build-section',nodes:[]}});
 const dispatched=await(await fetch(base+'/next?connectionId='+connectionId)).json();
 assert.equal(dispatched.command.target.clientName,'桌面设计');assert.equal(dispatched.command.target.pageId,'p1');
 const status=parse(await b.call('local_figma_status'));assert.equal(status.connections[0].busy,true);assert.equal(status.connections[0].queueLength,0);
 await post('/result',{connectionId,requestId:dispatched.requestId,ok:true,result:{roots:[{id:'created'}]}});
 assert.equal(parse(await pending).roots[0].id,'created');
 assert.equal((await a.call('local_figma_command',{bindingId:aa.bindingId,command:{type:'ping',pageId:'p2'}})).isError,true);
 assert.equal(parse(await a.call('local_figma_release',{bindingId:aa.bindingId})).ok,true);
 assert.equal(parse(await b.call('local_figma_release',{bindingId:bb.bindingId})).ok,true);
 assert.equal((await a.call('local_figma_node',{depth:-1})).isError,true);
 assert.equal((await a.rpc('unknown')).error.code,-32601);
 console.log('PASS MCP: 17 tools, write annotations, independent AI identities, binding ownership, structured writes, status during write, routing override rejection, release, validation');
}finally{clearTimeout(timer);for(const p of processes)p.kill();server.kill();}
