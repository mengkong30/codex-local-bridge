import http from 'node:http';
import {randomUUID} from 'node:crypto';
const host='localhost',port=Number(process.env.BRIDGE_PORT||37821);
const MAX_BODY_BYTES=32*1024*1024;
const allowedOrigins=new Set(['null','https://www.figma.com','https://figma.com']);
const sessions=new Map(),requests=new Map();
const TTL=45000;
const readTimeoutMs=Number(process.env.BRIDGE_READ_TIMEOUT_MS||15000),writeTimeoutMs=Number(process.env.BRIDGE_WRITE_TIMEOUT_MS||60000);
const completed=new Map();
function recordResult(p,s) {
 completed.set(p.requestId,{connectionId:s.id});if(completed.size>256)completed.delete(completed.keys().next().value);
 s.lastResult={requestId:p.requestId,ok:p.ok,error:p.error,completedAt:new Date().toISOString(),roots:p.result?.roots,nodeId:p.result?.nodeId||p.result?.id};
}
function json(res,status,value){if(res.writableEnded||res.destroyed)return;const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','vary':'Origin'};if(res.allowedOrigin){headers['access-control-allow-origin']=res.allowedOrigin;headers['access-control-allow-headers']='content-type';headers['access-control-allow-methods']='GET,POST,OPTIONS';}res.writeHead(status,headers);res.end(JSON.stringify(value));}
async function readJson(req){return new Promise((resolve,reject)=>{const chunks=[];let bytes=0,failed=false;req.on('data',c=>{if(failed)return;bytes+=c.length;if(bytes>MAX_BODY_BYTES){failed=true;const e=new Error('Request body exceeds 32 MiB');e.status=413;reject(e);return;}chunks.push(c);});req.on('end',()=>{if(failed)return;try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw Error('JSON object required');resolve(value);}catch(e){reject(e);}});req.on('error',reject);});}
function active(){return [...sessions.values()].filter(s=>Date.now()-s.seen<TTL);}
function info(s){return {...s.document,connectionId:s.id,lastSeen:new Date(s.seen).toISOString(),busy:!!s.busy,uncertain:!!s.uncertain,command:s.commandInfo||null,progress:s.progress||null,lastResult:s.lastResult||null};}
function pump(s){if(s.busy||s.uncertain||!s.waiter)return;let task;while(s.queue.length){task=s.queue.shift();if(requests.has(task.requestId))break;task=null;}if(!task)return;const res=s.waiter;s.waiter=null;s.busy=task.requestId;task.dispatched=true;s.commandInfo={requestId:task.requestId,type:task.command.type,dispatchedAt:new Date().toISOString()};s.progress=null;json(res,200,{requestId:task.requestId,connectionId:task.connectionId,command:task.command});}
const server=http.createServer(async(req,res)=>{try{
 if(![`localhost:${port}`,`127.0.0.1:${port}`,`[::1]:${port}`].includes(req.headers.host))return json(res,403,{ok:false,error:'Local requests only'});
 if(req.headers.origin&&!allowedOrigins.has(req.headers.origin))return json(res,403,{ok:false,error:'Browser origin is not allowed'});
 res.allowedOrigin=req.headers.origin;
 if(req.method==='OPTIONS')return json(res,204,{});
 if(req.method==='POST'&&!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return json(res,415,{ok:false,error:'application/json required'});
 if(Number(req.headers['content-length'])>MAX_BODY_BYTES)return json(res,413,{ok:false,error:'Request body exceeds 32 MiB'});
 const url=new URL(req.url,`http://${host}:${port}`);
 if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true,serverName:'codex-local-bridge',protocolVersion:2,serverVersion:"0.3.0",figmaConnected:active().length>0,connections:active().map(info)});
 if(req.method==='POST'&&url.pathname==='/hello'){
  const p=await readJson(req);if(p.protocolVersion!==2)return json(res,400,{ok:false,error:'Updated Figma plugin required: protocolVersion 2'}); if(!p.connectionId)p.connectionId=randomUUID(); if(typeof p.connectionId!=='string')return json(res,400,{ok:false,error:'Invalid connectionId'});
  let s=sessions.get(p.connectionId);if(!s){s={id:p.connectionId,queue:[],busy:null,uncertain:false,waiter:null};sessions.set(s.id,s);}s.document=p.document||{};s.seen=Date.now();return json(res,200,{ok:true,connectionId:s.id});
 }
 if(req.method==='GET'&&url.pathname==='/next'){
  const s=sessions.get(url.searchParams.get('connectionId'));if(!s)return json(res,409,{ok:false,error:'Register this connection first'});s.seen=Date.now();if(s.waiter)json(s.waiter,200,{});s.waiter=res;pump(s);
  const timer=setTimeout(()=>{if(s.waiter===res){s.waiter=null;json(res,200,{})}},20000);res.on('close',()=>{clearTimeout(timer);if(s.waiter===res)s.waiter=null});return;
 }
 if(req.method==='POST'&&url.pathname==='/progress'){
  const p=await readJson(req),s=sessions.get(p.connectionId);
  if(!s||s.busy!==p.requestId)return json(res,409,{ok:false,error:'Progress does not match active request'});
  s.seen=Date.now();s.progress={requestId:p.requestId,stage:p.stage,elapsedMs:p.elapsedMs,font:p.font,created:p.created,nodeName:p.nodeName,receivedAt:new Date().toISOString()};return json(res,200,{ok:true});
 }
 if(req.method==='POST'&&url.pathname==='/result'){
  const p=await readJson(req),task=requests.get(p.requestId),s=sessions.get(p.connectionId);
  if(completed.get(p.requestId)?.connectionId===p.connectionId)return json(res,200,{ok:true,duplicate:true});
  if(!s||s.busy!==p.requestId||(task&&task.connectionId!==s.id))return json(res,409,{ok:false,error:'Result does not match target connection'});
  s.seen=Date.now();recordResult(p,s);s.busy=null;s.uncertain=false;s.commandInfo=null;
  if(task){requests.delete(p.requestId);clearTimeout(task.timer);json(task.res,200,{...p,connectionId:s.id});}pump(s);return json(res,200,{ok:true});
 }
 if(req.method==='POST'&&url.pathname==='/command'){
  const input=await readJson(req),list=active();let s;
  if(input.connectionId)s=list.find(s=>s.id===input.connectionId);else if(list.length===1)s=list[0];else return json(res,409,{ok:false,error:list.length?'Multiple files connected; specify connectionId':'No Figma connection available'});
  if(!s)return json(res,409,{ok:false,error:'Target connection is disconnected or expired'});
  if(s.uncertain)return json(res,409,{ok:false,error:'Previous command outcome is uncertain; wait for its result or restart this Figma plugin'});
  const {connectionId,...command}=input;const requestId=randomUUID();const task={requestId,connectionId:s.id,command,res,dispatched:false};requests.set(requestId,task);
  task.timer=setTimeout(()=>{requests.delete(requestId);s.queue=s.queue.filter(t=>t!==task);if(task.dispatched){s.uncertain=true;for(const queued of s.queue){requests.delete(queued.requestId);clearTimeout(queued.timer);json(queued.res,409,{ok:false,error:'Stopped: previous command outcome is uncertain',connectionId:s.id});}s.queue=[];}
   json(res,504,{ok:false,error:task.dispatched?'Command timed out; outcome uncertain. Do not retry writes blindly.':'Command expired before dispatch',connectionId:s.id,requestId,progress:s.progress||null});},["build-section","design-system","import-image","export-node"].includes(command.type)?writeTimeoutMs:readTimeoutMs);
  s.queue.push(task);pump(s);return;
 }
 json(res,404,{ok:false,error:'Not found'});
}catch(e){json(res,e.status||400,{ok:false,error:e.message})}});
server.listen(port,host,()=>console.log(`Codex Figma bridge v2 listening on http://${host}:${port}`));
