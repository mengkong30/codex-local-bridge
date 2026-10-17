import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const port=37829,base='http://localhost:'+port;
const child=spawn(process.execPath,[root+'bridge-server.mjs'],{env:{...process.env,BRIDGE_PORT:String(port),BRIDGE_READ_TIMEOUT_MS:'160',BRIDGE_WRITE_TIMEOUT_MS:'650'},stdio:['ignore','ignore','inherit'],windowsHide:true});
async function post(path,p){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});return {status:r.status,...await r.json()};}
async function next(id){return (await fetch(base+'/next?connectionId='+id)).json();}
async function health(){return (await fetch(base+'/health')).json();}
try{
 for(let i=0;i<40;i++){try{if((await health()).ok)break;}catch{}await delay(50);}
 const a=(await post('/hello',{protocolVersion:2,document:{fileName:'A'}})).connectionId;
 const b=(await post('/hello',{protocolVersion:2,document:{fileName:'B'}})).connectionId;
 assert.equal((await post('/command',{type:'ping'})).status,409);
 const poll=next(a),result=post('/command',{connectionId:a,type:'build-section',nodes:[]});const cmd=await poll;
 await delay(210); // beyond read deadline, within write deadline
 assert.equal((await post('/progress',{connectionId:a,requestId:cmd.requestId,stage:'loading-font',font:{family:'test',style:'Regular'}})).status,200);
 assert.equal((await health()).connections.find(c=>c.connectionId===a).progress.stage,'loading-font');
 assert.equal((await post('/result',{connectionId:b,requestId:cmd.requestId,ok:true,result:{}})).status,409);
 const envelope={connectionId:a,requestId:cmd.requestId,ok:true,result:{roots:[{id:'test:1'}]}};
 assert.equal((await post('/result',envelope)).status,200);assert.equal((await result).ok,true);
 assert.equal((await post('/result',envelope)).duplicate,true); // lost acknowledgement safe retry
 const p2=next(a),r2=post('/command',{connectionId:a,type:'ping'});const c2=await p2;
 assert.equal((await r2).status,504);assert.equal((await health()).connections.find(c=>c.connectionId===a).uncertain,true);
 assert.equal((await post('/command',{connectionId:a,type:'build-section'})).status,409);
 await post('/result',{connectionId:a,requestId:c2.requestId,ok:true,result:{id:'late:1'}});
 let state=(await health()).connections.find(c=>c.connectionId===a);assert.equal(state.uncertain,false);assert.equal(state.lastResult.nodeId,'late:1');
 const p3=next(b),r3=post('/command',{connectionId:b,type:'ping'});const c3=await p3;await post('/result',{connectionId:b,requestId:c3.requestId,ok:true,result:{}});assert.equal((await r3).ok,true);
 console.log('PASS server: separate write deadline, progress, connection isolation, timeout lock, late-result recovery, duplicate acknowledgement');
}finally{child.kill();}

const code=await fs.readFile(root+'figma/code.js','utf8');
let loads=[],created=[],messages=[],failFont=false;
function node(type){const n={id:String(created.length+1),type,children:[],removed:false,appendChild(ch){this.children.push(ch);},resize(){},remove(){this.removed=true;}};created.push(n);return n;}
const parent={appendChild(){}};
const figma={showUI(){},ui:{postMessage(m){messages.push(m);}},getNodeByIdAsync:async()=>parent,currentPage:parent,loadFontAsync:async f=>{loads.push(f);if(failFont)throw Error('font unavailable');},createFrame:()=>node('FRAME'),createText:()=>node('TEXT'),createRectangle:()=>node('RECTANGLE')};
vm.runInNewContext(code,{figma,__html__:'',console,Date});
const texts=Array.from({length:40},(_,i)=>({kind:'TEXT',fontName:{family:'Microsoft YaHei',style:i%2?'Bold':'Regular'},characters:'test',width:100,height:30}));
await figma.ui.onmessage({type:'bridge-command',requestId:'one',command:{type:'build-section',nodes:[{kind:'FRAME',children:texts}]}});
assert.equal(loads.length,2);assert.equal(created.length,41);assert.equal(messages.at(-1).ok,true);assert.ok(messages.some(m=>m.stage==='building'&&m.created===40));
created=[];loads=[];messages=[];failFont=true;
await figma.ui.onmessage({type:'bridge-command',requestId:'two',command:{type:'build-section',nodes:[{kind:'FRAME',children:texts}]}});
assert.equal(created.length,0);assert.equal(messages.at(-1).ok,false);
created=[];messages=[];failFont=false;
await figma.ui.onmessage({type:'bridge-command',requestId:'three',command:{type:'build-section',nodes:[{kind:'FRAME',children:[{kind:'BAD'}]}]}});
assert.ok(created.every(n=>n.removed));assert.equal(messages.at(-1).ok,false);
console.log('PASS plugin: fonts deduplicated (40 texts / 2 loads), preflight leaves no partial nodes on font failure, construction rollback, progress emitted');

const html=await fs.readFile(root+'figma/ui.html','utf8');
let resultAttempts=0,status={};
const context={document:{getElementById:id=>id==='status'?status:{}},parent:{postMessage(){}},setTimeout:()=>0,fetch:async(url)=>{if(url.endsWith('/result')){resultAttempts++;if(resultAttempts===1)throw Error('network failure');return {ok:true,json:async()=>({ok:true})};}return {ok:true,json:async()=>({})};}};
vm.createContext(context);vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('      poll();',''),context);
context.setTimeout=fn=>{fn();return 0;};
await context.onmessage({data:{pluginMessage:{type:'bridge-result',requestId:'retry',ok:true,result:{}}}});
assert.equal(resultAttempts,2);assert.match(status.textContent,/已确认回传/);
console.log('PASS UI: failed result delivery retried and acknowledgement shown');
