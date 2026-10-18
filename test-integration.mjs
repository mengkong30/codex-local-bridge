import {figma,page,messages,registry} from './test-runtime.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const outputDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-integration-'));
const root=fileURLToPath(new URL('.',import.meta.url)),port=37835,base='http://127.0.0.1:'+port,env={...process.env,BRIDGE_PORT:String(port),FIGMA_BRIDGE_ROOT:root};
const server=spawn(process.execPath,[root+'bridge-server.mjs'],{env,stdio:['ignore','ignore','inherit'],windowsHide:true});
const mcp=spawn(process.execPath,[root+'mcp-server.mjs'],{env,stdio:['pipe','pipe','inherit'],windowsHide:true});
let id=0,buf='',running=true;const pending=new Map();mcp.stdout.on('data',chunk=>{buf+=chunk;let n;while((n=buf.indexOf('\n'))>=0){const value=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);pending.get(value.id)?.(value.result);pending.delete(value.id);}});
const rpc=(method,params)=>new Promise(resolve=>{const num=++id;pending.set(num,resolve);mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:num,method,params})+'\n');});
const call=async(name,args)=>{const r=await rpc('tools/call',{name,arguments:args});assert.equal(r.isError,undefined,JSON.stringify(r));return r;};const parse=r=>JSON.parse(r.content[0].text);
const post=async(route,p)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});return r.json();};
const delay=ms=>new Promise(r=>setTimeout(r,ms));const timeout=setTimeout(()=>{mcp.kill();server.kill();process.exit(1);},20000);let worker;
async function dsh(args){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[root+'adapters/dsh-bridge.mjs',...args],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',err='';child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.on('exit',code=>code?reject(Error(err)):resolve(JSON.parse(out)));});}
try{
 for(let i=0;i<40;i++){try{if((await(await fetch(base+'/health')).json()).ok)break;}catch{}await delay(25);}
 const connectionId=(await post('/hello',{protocolVersion:2,document:{fileName:'Integration fixture',bridgeVersion:9,panelProtocol:1,pages:[{id:page.id,name:page.name}],pageId:page.id}})).connectionId;
 worker=(async()=>{while(running){let incoming;try{incoming=await(await fetch(base+'/next?connectionId='+connectionId)).json();}catch{break;}if(!incoming.command)continue;messages.length=0;await figma.ui.onmessage({type:'bridge-command',...incoming});for(const m of [...messages])if(m.type==='bridge-progress')await post('/progress',{connectionId,...m});const result=messages.findLast(m=>m.type==='bridge-result');await post('/result',{connectionId,...result});}})();
 const binding=parse(await call('local_figma_bind',{connectionId,pageId:page.id,clientName:'E2E acceptance',aiName:'Codex'})).binding;
 const c={type:'create-kpi-card',key:'e2e-kpi',label:'收益',value:42,idempotencyKey:'e2e-kpi-create'};
 const preview=parse(await call('local_figma_command',{bindingId:binding.bindingId,command:{...c,idempotencyKey:'preview',dryRun:true}}));assert.equal(preview.writes,0);
 const result=parse(await call('local_figma_command',{bindingId:binding.bindingId,command:c}));assert.ok(result.id&&result.operationId);const replay=parse(await call('local_figma_command',{bindingId:binding.bindingId,command:c}));assert.equal(replay.id,result.id);
 const query=parse(await call('local_figma_operation',{bindingId:binding.bindingId,idempotencyKey:'e2e-kpi-create'}));assert.equal(query.operation.state,'succeeded');assert.equal(query.operation.requestId,result.operationId);
 const report=await call('local_figma_validate_layout',{bindingId:binding.bindingId,nodeId:result.id});assert.ok(report.content.some(c=>c.type==='image'));assert.ok(parse(report).screenshots[0].width);
 const undoPreview=parse(await call('local_figma_undo',{bindingId:binding.bindingId,operationId:result.operationId,dryRun:true}));assert.equal(undoPreview.dryRun,true);
 const undo=parse(await call('local_figma_undo',{bindingId:binding.bindingId,operationId:result.operationId}));assert.equal(undo.undone,true);assert.equal(registry.has(result.id),false);
 await call('local_figma_release',{bindingId:binding.bindingId});
 const db=(await dsh(['bind','--connection',connectionId,'--page',page.id,'--name','DSH acceptance'])).binding;
 const flags=['--connection',connectionId,'--client',db.clientId,'--binding',db.bindingId];
 const dResult=await dsh(['command',JSON.stringify({type:'create-kpi-card',key:'dsh-kpi',value:99,idempotencyKey:'dsh-create'}),...flags]);assert.ok(dResult.operationId);
 const dQuery=await dsh(['operation',dResult.operationId,...flags]);assert.equal(dQuery.operation.state,'succeeded');
 const out=path.join(outputDirectory,'dsh-report.json');const dReport=await dsh(['validate-layout',dResult.id,'--out',out,...flags]);assert.ok(fs.existsSync(dReport.report));assert.ok(JSON.parse(fs.readFileSync(out,'utf8')).screenshots[0].file);
 assert.equal((await dsh(['undo',dResult.operationId,...flags])).undone,true);await dsh(['release',...flags]);
 console.log('PASS end-to-end assembled runtime → HTTP → MCP and DSH: dry-run, idempotent build, operation query, PNG report/image blocks, undo preflight/execute, binding isolation and cleanup');
}finally{running=false;mcp.kill();server.kill();clearTimeout(timeout);await worker?.catch(()=>{});fs.rmSync(outputDirectory,{recursive:true,force:true});}
