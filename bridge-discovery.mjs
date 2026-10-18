import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
export const DEFAULT_PORTS=Array.from({length:8},(_,i)=>37821+i);
export const VERSION='0.7.0';
export const stateDirectory=()=>process.env.BRIDGE_STATE_DIR||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.local','state'),'CodexLocalBridge');
export function optionsFromEnv(env=process.env){const explicit=env.BRIDGE_PORT!==undefined,port=Number(env.BRIDGE_PORT||37821),profile=String(env.BRIDGE_PROFILE||(explicit?'port-'+port:'default')).toLowerCase();if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid bridge port');if(!/^[\w.-]{1,60}$/.test(profile))throw Error('Invalid bridge profile');return {port,profile,ports:explicit?[port]:env.BRIDGE_DISCOVERY_PORTS?env.BRIDGE_DISCOVERY_PORTS.split(',').map(p=>{const v=Number(p);if(!Number.isInteger(v)||v<1024||v>65535)throw Error('Invalid discovery port');return v;}):DEFAULT_PORTS};}
export async function probe(base,timeout=450){try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(timeout)});if(!r.ok)return null;const h=await r.json();if(!h.ok||h.serverName!=='codex-local-bridge'||h.protocolVersion!==2)return null;return {...h,endpoint:base};}catch{return null;}}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const fileFor=(profile,suffix)=>path.join(stateDirectory(),'profile-'+profile+suffix);
export async function discover(options=optionsFromEnv()){
 const {profile,ports}=options;let registry;
 try{registry=JSON.parse(await fs.readFile(fileFor(profile,'.json'),'utf8'));}catch{}
 if(registry&&ports.includes(registry.port)){const h=await probe('http://127.0.0.1:'+registry.port);if(h?.profile===profile&&h.instanceId===registry.instanceId)return h;}
 const found=(await Promise.all(ports.map(p=>probe('http://127.0.0.1:'+p)))).filter(Boolean).filter(h=>(h.profile||'default')===profile);
 if(found.length>1)throw Error('Multiple services claim profile '+profile+'; choose an explicit port instead of guessing');
 return found[0]||null;
}
async function acquire(profile,suffix){
 await fs.mkdir(stateDirectory(),{recursive:true});const filename=fileFor(profile,suffix),nonce=randomUUID();
 for(let attempt=0;attempt<3;attempt++){
  try{const f=await fs.open(filename,'wx');try{await f.writeFile(JSON.stringify({pid:process.pid,nonce,createdAt:Date.now()}));}finally{await f.close();}return async()=>{try{const old=JSON.parse(await fs.readFile(filename,'utf8'));if(old.nonce===nonce)await fs.unlink(filename);}catch{}};}catch(e){if(e.code!=='EEXIST')throw e;
   try{const old=JSON.parse(await fs.readFile(filename,'utf8'));if(Number.isInteger(old.pid)&&old.pid>0&&!alive(old.pid)){await fs.unlink(filename);continue;}}catch(readError){if(readError.code==='ENOENT')continue;try{const stat=await fs.stat(filename);if(Date.now()-stat.mtimeMs>30000){await fs.unlink(filename);continue;}}catch{}}
   return null;
  }
 }
 return null;
}
export async function startCoordinatedServer(server,options,metadata){
 const release=await acquire(options.profile,'.instance-lock');
 if(!release){const existing=await discover(options);throw Object.assign(Error(existing?'Bridge instance already running at '+existing.endpoint:'Bridge profile is starting or held by a live process'),{code:'INSTANCE_EXISTS',existing});}
 let actualPort;
 try{
  for(const candidate of options.ports){try{await new Promise((resolve,reject)=>{const error=e=>{server.off('listening',listening);reject(e);},listening=()=>{server.off('error',error);resolve();};server.once('error',error);server.once('listening',listening);server.listen(candidate,'127.0.0.1');});actualPort=candidate;break;}catch(e){if(e.code!=='EADDRINUSE')throw e;}}
  if(!actualPort)throw Error('No free port in '+options.ports.join(', '));
  const descriptor={...metadata,pid:process.pid,port:actualPort,profile:options.profile,updatedAt:Date.now()},filename=fileFor(options.profile,'.json');
  await fs.writeFile(filename,JSON.stringify(descriptor));
  server.once('close',async()=>{try{const saved=JSON.parse(await fs.readFile(filename,'utf8'));if(saved.instanceId===metadata.instanceId)await fs.unlink(filename);}catch{}await release();});
  return {port:actualPort,profile:options.profile};
 }catch(e){await release();throw e;}
}
export async function ensureDiscovered(root,options=optionsFromEnv()){
 const existing=await discover(options);if(existing)return existing;
 const release=await acquire(options.profile,'.startup-lock');
 if(release){try{const again=await discover(options);if(again)return again;const childEnv={...process.env,BRIDGE_PROFILE:options.profile,BRIDGE_DISCOVERY_PORTS:options.ports.join(',')};if(options.ports.length===1)childEnv.BRIDGE_PORT=String(options.port);else delete childEnv.BRIDGE_PORT;const child=spawn(process.execPath,[path.join(root,'bridge-server.mjs')],{cwd:root,env:childEnv,detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();
  for(let i=0;i<35;i++){await new Promise(r=>setTimeout(r,150));const ready=await discover(options);if(ready)return ready;}throw Error('Bridge startup failed for profile '+options.profile+'; inspect port conflict and local service version');
 }finally{await release();}}
 for(let i=0;i<45;i++){await new Promise(r=>setTimeout(r,150));const ready=await discover(options);if(ready)return ready;}throw Error('Another client is starting the bridge but no compatible instance became ready');
}
export function compatibility(h,runtime){
 const reasons=[];if(h.protocolVersion!==2)reasons.push('Service protocol 2 required');if(h.discoveryProtocol!==1)reasons.push('Service discovery update required (0.7.0)');if(h.controllerProtocol!==1||h.panelProtocol!==1)reasons.push('Controller/panel protocol update required');if(h.reliabilityProtocol!==1)reasons.push('Reliable-write service update required');if(runtime!==undefined&&runtime<10)reasons.push('Reopen Figma plugin runtime v10');return {compatible:!reasons.length,reasons,required:{service:'0.7.0',runtime:10},current:{service:h.serverVersion,runtime},scope:'local installed package; no remote release feed'};
}
