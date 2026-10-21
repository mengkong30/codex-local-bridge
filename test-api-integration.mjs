import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {figma,page,messages,registry} from './test-api.mjs';
const root=fileURLToPath(new URL('.',import.meta.url)),port=38906,base='http://127.0.0.1:'+port,state=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-api-e2e-'));
const env={...process.env,BRIDGE_PORT:String(port),BRIDGE_STATE_DIR:state};
const server=spawn(process.execPath,[root+'bridge-server.mjs'],{env,stdio:['ignore','ignore','inherit'],windowsHide:true});
const mcp=spawn(process.execPath,[root+'mcp-server.mjs'],{env,stdio:['pipe','pipe','inherit'],windowsHide:true});
let sequence=0,buffer='',running=true;const pending=new Map();
mcp.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);pending.get(message.id)?.(message);pending.delete(message.id);}});
function rpc(method,params={}){return new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
const call=async(name,args={})=>(await rpc('tools/call',{name,arguments:args})).result;
const parse=result=>{assert.equal(result.isError,undefined,JSON.stringify(result));return JSON.parse(result.content.find(c=>c.type==='text').text);};
const post=async(route,p)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p),signal:AbortSignal.timeout(5000)});return {status:r.status,...await r.json()};};
const delay=ms=>new Promise(r=>setTimeout(r,ms));let worker;
const timer=setTimeout(()=>{mcp.kill();server.kill();process.exit(1);},30000);
try {
 for(let i=0;i<50;i++){try{if((await(await fetch(base+'/health')).json()).ok)break;}catch{}await delay(25);}
 const document={fileName:'Expanded API fixture',pageId:page.id,pageName:page.name,pages:[{id:page.id,name:page.name}],bridgeVersion:11,editorType:'figma'};
 const connectionId=(await post('/hello',{protocolVersion:2,document})).connectionId;
 worker=(async()=>{while(running){let incoming;try{incoming=await(await fetch(base+'/next?connectionId='+connectionId)).json();}catch{break;}if(!incoming.command)continue;messages.length=0;await figma.ui.onmessage({type:'bridge-command',...incoming});const result=messages.findLast(m=>m.type==='bridge-result');await post('/result',{connectionId,...result});}})();
 assert.equal((await rpc('initialize')).result.serverInfo.version,'0.8.2');
 assert.equal((await rpc('tools/list')).result.tools.length,17);
 const capabilities=parse(await call('local_figma_capabilities',{connectionId}));assert.equal(capabilities.version,11);assert.ok(capabilities.api.commands.includes('import-library'));
 const binding=parse(await call('local_figma_bind',{connectionId,pageId:page.id,clientName:'Expanded acceptance',aiName:'Codex'})).binding;
 const create={type:'create-node',node:{kind:'RECTANGLE',name:'MCP fixture',rotation:20,width:80,height:40},idempotencyKey:'expanded-create'};
 const preview=parse(await call('local_figma_command',{bindingId:binding.bindingId,command:{...create,idempotencyKey:'expanded-preview',dryRun:true}}));assert.equal(preview.writes,0);
 const result=parse(await call('local_figma_command',{bindingId:binding.bindingId,command:create}));const count=registry.size;
 assert.equal(parse(await call('local_figma_command',{bindingId:binding.bindingId,command:create})).id,result.id);assert.equal(registry.size,count);
 assert.equal(parse(await call('local_figma_operation',{bindingId:binding.bindingId,idempotencyKey:'expanded-create'})).operation.state,'succeeded');
 const update=parse(await call('local_figma_command',{bindingId:binding.bindingId,command:{type:'update-node',nodeId:result.id,props:{rotation:45,cornerRadius:12}}}));assert.equal(registry.get(result.id).cornerRadius,12);
 parse(await call('local_figma_undo',{bindingId:binding.bindingId,operationId:update.operationId}));assert.equal(registry.get(result.id).cornerRadius,0);
 const jpg=await call('local_figma_export',{bindingId:binding.bindingId,nodeId:result.id,format:'JPG',settings:{constraint:{type:'WIDTH',value:800}}});assert.equal(jpg.content[0].type,'image');assert.equal(jpg.content[0].mimeType,'image/jpeg');
 const pdf=await call('local_figma_export',{bindingId:binding.bindingId,nodeId:result.id,format:'PDF'});assert.equal(pdf.content[1].type,'resource');assert.equal(pdf.content[1].resource.mimeType,'application/pdf');assert.equal(Buffer.from(pdf.content[1].resource.blob,'base64').toString(),'%PDF');
 const denied=await call('local_figma_command',{bindingId:binding.bindingId,command:{type:'style-action',action:'create',styleType:'PAINT',name:'Wrong scope'}});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/exclusive file binding/);
 const risky=await call('local_figma_command',{bindingId:binding.bindingId,command:{type:'delete-node',nodeId:result.id}});assert.equal(risky.isError,true);assert.equal(registry.has(result.id),true);
 parse(await call('local_figma_release',{bindingId:binding.bindingId}));
 // Old workers must be rejected before dispatching the new command vocabulary.
 const old=(await post('/hello',{protocolVersion:2,document:{...document,bridgeVersion:10}})).connectionId;
 const clientId=(await post('/clients/register',{aiName:'Fixture',name:'Old worker'})).clientId;
 const oldBinding=(await post('/bindings',{connectionId:old,clientId,pageId:page.id})).binding;
 const oldAttempt=await post('/command',{connectionId:old,clientId,bindingId:oldBinding.bindingId,type:'create-node',node:{kind:'FRAME'}});assert.equal(oldAttempt.status,409);assert.match(oldAttempt.error,/runtime v11/);
 // A Dev session is blocked by the HTTP service even if its worker misreports success.
 const dev=(await post('/hello',{protocolVersion:2,document:{...document,editorType:'dev'}})).connectionId;
 const devBinding=(await post('/bindings',{connectionId:dev,clientId,pageId:page.id})).binding;
 const devAttempt=await post('/command',{connectionId:dev,clientId,bindingId:devBinding.bindingId,type:'delete-node',nodeId:result.id,allowNonUndoable:true});assert.equal(devAttempt.status,409);assert.match(devAttempt.error,/read-only/);assert.equal(registry.has(result.id),true);
 console.log('PASS expanded MCP/HTTP/runtime integration: capabilities, preview, one write per key, query, property undo, JPG image blocks, PDF resources, file-scope guards, destructive guard, old-worker rejection and Dev read-only dispatch');
}finally{running=false;clearTimeout(timer);mcp.kill();server.kill();await worker?.catch(()=>{});await fs.rm(state,{recursive:true,force:true});}
