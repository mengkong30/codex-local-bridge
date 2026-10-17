import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const base='http://localhost:'+Number(process.env.BRIDGE_PORT||37821);
const root=fileURLToPath(new URL('.',import.meta.url));
const properties={nodeId:{type:'string',description:'Exact Figma node ID.'},depth:{type:'integer',minimum:0,maximum:50},format:{type:'string',enum:['SVG','PNG']},scale:{type:'number',minimum:0.1,maximum:4}};
const spec=(name,description,props={},required=[])=>({name,description,inputSchema:{type:'object',properties:{connectionId:{type:'string',description:'Target connection ID from local_figma_status. Required when multiple files are connected.'},...props},required,additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}});
const list=[spec('local_figma_connect','Start the local bridge and return connection status and Figma plugin manifest path. No key required.'),spec('local_figma_status','Read live connection status.'),spec('local_figma_document','Read the active file, page and current selection.'),spec('local_figma_pages','List pages and their top-level nodes.'),spec('local_figma_node','Read node properties and descendants.',{nodeId:properties.nodeId,depth:properties.depth},['nodeId']),spec('local_figma_export','Export a node as PNG or SVG.',{nodeId:properties.nodeId,format:properties.format,scale:properties.scale},['nodeId'])];
async function health(){try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(800)});return r.ok?await r.json():null;}catch{return null;}}
let starting;
async function ensure(){
 const h=await health();if(h?.ok){if(h.serverName!=='codex-local-bridge'||h.protocolVersion!==2)throw Error('An incompatible service is running on the bridge port. Inspect and stop the old bridge before upgrading.');return h;}
 if(!starting)starting=(async()=>{
  const child=spawn(process.execPath,[root+'bridge-server.mjs'],{cwd:root,detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();
  for(let i=0;i<25;i++){await new Promise(r=>setTimeout(r,200));const h=await health();if(h?.ok&&h.serverName==='codex-local-bridge'&&h.protocolVersion===2)return h;}
  throw Error('Local bridge could not start on localhost:37821.');
 })().finally(()=>{starting=null;});return starting;
}
async function command(body){await ensure();const r=await fetch(base+'/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(65000)});const result=await r.json();if(!r.ok||!result.ok)throw Error(result.error||'Figma command failed');return result.result;}
async function call(name,args){
 if(!list.some(t=>t.name===name))throw Error('Unknown tool');
 if(!args||Array.isArray(args)||typeof args!=='object')throw Error('Arguments must be an object');
 if(args.connectionId!==undefined&&(typeof args.connectionId!=='string'||!args.connectionId))throw Error('connectionId must be a nonempty string');
 if(name==='local_figma_connect'||name==='local_figma_status'){
  await ensure();let document=null;try{document=await command({type:'get-document-info',...(args.connectionId?{connectionId:args.connectionId}:{})});}catch{}
  const state=await health();
  return {running:true,figmaConnected:state.figmaConnected,connections:state.connections||[],protocolVersion:state.protocolVersion,document,manifestPath:root+'figma/manifest.json',setup:document?'Connected':state.connections?.some(c=>c.uncertain)?'Previous command is unresolved; inspect progress and lastResult. Do not replay writes.':state.connections?.some(c=>c.busy)?'Figma command is running; inspect progress.':state.connections?.length>1?'Multiple files connected; specify connectionId.':'In Figma Desktop, import this manifest and run Codex Local Bridge. No key is needed.'};
 }
 if(['local_figma_node','local_figma_export'].includes(name)&&(!args.nodeId||typeof args.nodeId!=='string'))throw Error('nodeId is required');
 if(args.depth!==undefined&&(!Number.isInteger(args.depth)||args.depth<0||args.depth>50))throw Error('depth must be 0–50');
 if(args.scale!==undefined&&(!(args.scale>=0.1)||args.scale>4))throw Error('scale must be 0.1–4');
 if(args.format!==undefined&&!['SVG','PNG'].includes(args.format))throw Error('format must be SVG or PNG');
 const types={local_figma_document:'get-document-info',local_figma_pages:'get-pages',local_figma_node:'get-node',local_figma_export:'export-node'};
 return command({...args,type:types[name]});
}
const send=o=>process.stdout.write(JSON.stringify(o)+'\n');
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',async line=>{
 let m;try{m=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}
 if(m.id===undefined)return;
 try{
 let result;
 if(m.method==='initialize')result={protocolVersion:m.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'codex-local-bridge',version:'0.3.0'}};
 else if(m.method==='ping')result={};
 else if(m.method==='tools/list')result={tools:list};
 else if(m.method==='tools/call'){
  try{const value=await call(m.params.name,m.params.arguments||{});result=value?.format==='PNG'?{content:[{type:'image',data:value.base64,mimeType:'image/png'}]}:{content:[{type:'text',text:JSON.stringify(value)}]};}
  catch(e){result={isError:true,content:[{type:'text',text:e.message}]};}
 }else {send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});return;}
 send({jsonrpc:'2.0',id:m.id,result});
 }catch(e){send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:e.message}});}
});
