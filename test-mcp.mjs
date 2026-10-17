import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import http from 'node:http';
import assert from 'node:assert/strict';

// An isolated synthetic bridge ensures no actual Figma or default port is touched.
const port=38643;
const server=http.createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url==='/health')return res.end(JSON.stringify({ok:true,serverName:'codex-local-bridge',protocolVersion:2,serverVersion:'0.3.0',figmaConnected:true,connections:[{connectionId:'synthetic-target',fileName:'Synthetic file'}]}));
 const parts=[];for await(const c of req)parts.push(c);const body=JSON.parse(Buffer.concat(parts));
 assert.equal(body.connectionId,'synthetic-target');
 const result=body.type==='export-node'?{format:'PNG',base64:'c3ludGhldGlj'}:{fileName:'Synthetic file',selection:[]};
 res.end(JSON.stringify({ok:true,result}));
});
server.listen(port,'localhost');await once(server,'listening');
const child=spawn(process.execPath,[fileURLToPath(new URL('./mcp-server.mjs',import.meta.url))],{env:{...process.env,BRIDGE_PORT:String(port)},stdio:['pipe','pipe','inherit'],windowsHide:true});
let buffer='';const pending=new Map();let id=0;
child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);pending.get(message.id)?.(message);pending.delete(message.id);}});
function rpc(method,params={}){return new Promise(resolve=>{const requestId=++id;pending.set(requestId,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');});}
const timeout=setTimeout(()=>{child.kill();server.close();throw Error('MCP test timeout');},10000);
try{
 assert.equal((await rpc('initialize',{protocolVersion:'2024-11-05'})).result.serverInfo.version,'0.3.0');
 const tools=(await rpc('tools/list')).result.tools;assert.equal(tools.length,6);assert.ok(tools.every(t=>t.annotations.readOnlyHint));
 const doc=await rpc('tools/call',{name:'local_figma_document',arguments:{connectionId:'synthetic-target'}});assert.ok(!doc.result.isError);assert.equal(JSON.parse(doc.result.content[0].text).fileName,'Synthetic file');
 const png=await rpc('tools/call',{name:'local_figma_export',arguments:{connectionId:'synthetic-target',nodeId:'synthetic-node',format:'PNG'}});assert.equal(png.result.content[0].type,'image');
 for(const args of [{depth:-1},{depth:51},{nodeId:'x',scale:5},{nodeId:'x',format:'JPEG'},{nodeId:'x',connectionId:42}]){
  const bad=await rpc('tools/call',{name:'local_figma_node',arguments:args});assert.equal(bad.result.isError,true);
 }
 assert.equal((await rpc('unknown')).error.code,-32601);
 console.log('PASS MCP: stdio handshake, six read tools, routed synthetic document/export, invalid inputs, unknown method; no real design read');
}finally{clearTimeout(timeout);child.kill();server.close();await once(child,'exit');}
