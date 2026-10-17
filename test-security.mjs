import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {fileURLToPath} from 'node:url';

const port=38642,base=`http://localhost:${port}`;
const child=spawn(process.execPath,[fileURLToPath(new URL('./bridge-server.mjs',import.meta.url))],{env:{...process.env,BRIDGE_PORT:String(port)},stdio:['ignore','pipe','inherit'],windowsHide:true});
await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Test server could not start');}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Startup timeout')),5000);t.unref();})]);
async function request(path,init={}){return fetch(base+path,{...init,signal:AbortSignal.timeout(10000)});}
try{
 assert.equal((await request('/health')).status,200);
 let r=await request('/health',{headers:{Origin:'https://untrusted.example'}});assert.equal(r.status,403);assert.equal(r.headers.get('access-control-allow-origin'),null);
 r=await request('/command',{method:'OPTIONS',headers:{Origin:'https://untrusted.example','Access-Control-Request-Method':'POST'}});assert.equal(r.status,403);
 for(const origin of ['null','https://www.figma.com','https://figma.com']){
  r=await request('/health',{headers:{Origin:origin}});assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),origin);
 }
 r=await request('/hello',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'});assert.equal(r.status,415);
 r=await request('/hello',{method:'POST',headers:{'content-type':'application/json'},body:'[]'});assert.equal(r.status,400);
 const raw=(headers,body)=>new Promise((resolve,reject)=>{const req=http.request(base+'/hello',{method:'POST',headers,agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);if(body){for(let i=0;i<body.length;i+=1024*1024)req.write(body.subarray?body.subarray(i,i+1024*1024):body.slice(i,i+1024*1024));}req.end();});
 assert.equal(await raw({host:'untrusted.example','content-type':'application/json'},'{}'),403);
 assert.equal(await raw({'content-type':'application/json','content-length':String(32*1024*1024+1)},''),413);
 const chunked=await raw({'content-type':'application/json','transfer-encoding':'chunked'},Buffer.alloc(32*1024*1024+1,32));assert.equal(chunked,413);
 r=await request('/hello',{method:'POST',headers:{'content-type':'application/json',Origin:'null'},body:JSON.stringify({protocolVersion:2,document:{fileName:'Synthetic sample'}})});assert.equal(r.status,200);assert.ok((await r.json()).connectionId);
 console.log('PASS security: Host, Origin/preflight, Figma/null, JSON objects, declared/chunked body limits; no authentication claimed');
}finally{child.kill();await once(child,'exit');}
