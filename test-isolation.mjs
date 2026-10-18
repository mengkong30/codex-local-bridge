import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const root = new URL('.', import.meta.url), port = 37829, base = 'http://localhost:' + port;
const delay = ms => new Promise(r => setTimeout(r, ms));
const child = spawn(process.execPath, [new URL('bridge-server.mjs', root).pathname.replace(/^\/(.:)/, '$1')], {env:{...process.env, BRIDGE_PORT:String(port), BRIDGE_READ_TIMEOUT_MS:'300', BRIDGE_WRITE_TIMEOUT_MS:'1100', BRIDGE_LEASE_MS:'5000', BRIDGE_CONNECTION_TTL_MS:'3000'}, stdio:['ignore','ignore','inherit'], windowsHide:true});
async function post(path, p) {const r = await fetch(base + path, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(p), signal:AbortSignal.timeout(4000)}); return {status:r.status, ...await r.json()};}
async function next(id) {return (await fetch(base + '/next?connectionId=' + id, {signal:AbortSignal.timeout(4000)})).json();}
async function health() {return (await fetch(base + '/health')).json();}
const document = name => ({fileName:name, pageId:'p1', pageName:'页面一', bridgeVersion:9, pages:[{id:'p1',name:'页面一'},{id:'p2',name:'页面二'}]});
async function complete(id, c, result={}) {return post('/result', {connectionId:id, requestId:c.requestId, ok:true, result});}
try {
 for (let i=0;i<40;i++) {try {if ((await health()).ok) break;} catch {} await delay(50);}
 const a=(await post('/hello',{protocolVersion:2,document:document('文件 A')})).connectionId;
 const b=(await post('/hello',{protocolVersion:2,document:document('文件 B')})).connectionId;
 const ca=(await post('/clients/register',{name:'园区大屏',aiName:'Codex'})).clientId;
 const cb=(await post('/clients/register',{name:'移动端设计',aiName:'DeepSeek'})).clientId;
 const bind=async(clientId,connectionId,pageId,scope='page')=>post('/bindings',{clientId,connectionId,pageId,scope});
 const ba=(await bind(ca,a,'p1')).binding, bb=(await bind(cb,a,'p2')).binding, bc=(await bind(cb,b,'p1')).binding;
 assert.ok(ba.bindingId && bb.bindingId && bc.bindingId);
 assert.equal((await bind(cb,a,'p1')).status,409);
 assert.equal((await bind(ca,a,'p2','file')).status,409);
 assert.equal((await bind(ca,a,'missing')).status,409);
 assert.equal((await bind(ca,a,'p1')).binding.bindingId,ba.bindingId);
 assert.equal((await post('/command',{type:'ping'})).status,409);
 assert.equal((await post('/command',{connectionId:a,type:'update-node',nodeId:'n'})).status,409);
 const routing=x=>({bindingId:x.bindingId,clientId:x.clientId});
 assert.equal((await post('/command',{...routing(ba),clientId:cb,type:'ping'})).status,409);
 assert.equal((await post('/command',{...routing(ba),connectionId:b,type:'ping'})).status,409);
 assert.equal((await post('/command',{...routing(ba),pageId:'p2',type:'ping'})).status,409);
 assert.equal((await post('/command',{...routing(ba),type:'design-system',action:'variable'})).status,409);
 const pa=next(a), ra=post('/command',{...routing(ba),type:'update-node',nodeId:'n',props:{x:10}}), ac=await pa;
 assert.equal(ac.command.target.aiName,'Codex'); assert.equal(ac.command.target.pageId,'p1');
 // A second page is queued in this file, while another file executes immediately.
 const rb=post('/command',{...routing(bb),type:'build-section',nodes:[]});
 const pc=next(b), rc=post('/command',{...routing(bc),type:'build-section',nodes:[]}), cc=await pc;
 assert.equal(cc.command.target.fileName,'文件 B');
 await complete(b,cc); assert.equal((await rc).ok,true);
 await delay(350); // update-node must use the write deadline, not 300ms read deadline
 assert.equal((await post('/progress',{connectionId:a,requestId:ac.requestId,stage:'building',created:12})).ok,true);
 let state=(await health()).connections.find(s=>s.connectionId===a);
 assert.equal(state.progress.created,12); assert.equal(state.queueLength,1);
 assert.equal(state.bindings.find(x=>x.bindingId===bb.bindingId).state,'queued');
 assert.equal((await post('/bindings/revoke',{connectionId:a,bindingId:ba.bindingId})).status,409);
 assert.equal((await post('/bindings/release',routing(bb))).status,409);
 assert.equal((await post('/disconnect',{connectionId:a})).status,409);
 assert.equal((await complete(b,ac)).status,409);
 await complete(a,ac,{id:'updated'}); assert.equal((await ra).ok,true);
 assert.equal((await complete(a,ac)).duplicate,true);
 const queued=await next(a); assert.equal(queued.command.target.pageId,'p2');
 await complete(a,queued); assert.equal((await rb).ok,true);
 // Manually viewing another page updates metadata but never changes bindings.
 await post('/hello',{protocolVersion:2,connectionId:a,document:{...document('文件 A'),pageId:'p2',pageName:'页面二'}});
 state=(await health()).connections.find(s=>s.connectionId===a);
 assert.equal(state.bindings.find(x=>x.bindingId===ba.bindingId).pageId,'p1');
 assert.equal((await post('/bindings/heartbeat',routing(ba))).ok,true);
 // A timed-out dispatched command locks its file, including release/reassignment.
 const pt=next(a), rt=post('/command',{...routing(ba),type:'ping'}), ct=await pt;
 assert.equal((await rt).status,504);
 assert.equal((await post('/command',{...routing(bb),type:'ping'})).status,409);
 assert.equal((await post('/bindings/revoke',{connectionId:a,bindingId:ba.bindingId})).status,409);
 await complete(a,ct,{id:'late'});
 state=(await health()).connections.find(s=>s.connectionId===a);assert.equal(state.uncertain,false);assert.equal(state.lastResult.nodeId,'late');
 assert.equal((await post('/bindings/release',routing(ba))).ok,true);
 assert.equal((await post('/command',{...routing(ba),type:'ping'})).status,409);
 assert.equal((await post('/bindings/release',routing(bb))).ok,true);
 const exclusive=(await bind(ca,a,'p1','file')).binding;
 assert.equal((await bind(cb,a,'p2')).status,409);
 assert.equal((await post('/bindings/release',routing(exclusive))).ok,true);
 assert.equal((await post('/disconnect',{connectionId:a})).ok,true);
 assert.equal((await post('/command',{connectionId:a,type:'ping'})).status,409);
 const renewed=(await post('/hello',{protocolVersion:2,connectionId:a,document:document('文件 A')})).connectionId;
 assert.notEqual(renewed,a);
 const old=(await post('/hello',{protocolVersion:2,document:{fileName:'old',pages:[]}})).connectionId;
 assert.equal((await bind(ca,old,'p1')).status,409);
 const origin=await fetch(base+'/health',{headers:{Origin:'https://example.com'}});assert.equal(origin.status,403);
 // Losing a plugin session expires its binding; reconnect never revives old IDs.
 await delay(3200);
 assert.equal((await post('/command',{...routing(bc),type:'ping'})).status,409);
 assert.notEqual((await post('/hello',{protocolVersion:2,connectionId:b,document:document('文件 B')})).connectionId,b);
 console.log('PASS server: page/file claims, identity, conflict rejection, per-file queues, parallel files, explicit target, update timeout, progress, late result, revocation, reconnect, expiry, origin checks');
} finally {child.kill();}

// Execute the actual plugin code with a small Figma document, not copied logic.
const code=await readFile(new URL('figma/code.js',root),'utf8');
let messages=[],created=[],loads=[],failFont=false,nextId=0;
const nodes=new Map();
function make(type,id=String(++nextId)) {
 const n={id,type,name:id,children:[],selection:[],removed:false,getStyledTextSegments(){return [];},getRangeAllFontNames(){return this.fontName?[this.fontName]:[];},getPluginData(){return '';},setPluginData(){},insertChild(i,ch){this.appendChild(ch);this.children.splice(this.children.indexOf(ch),1);this.children.splice(i,0,ch);},appendChild(ch){if(ch.parent){ch.parent.children=ch.parent.children.filter(x=>x!==ch);}this.children.push(ch);ch.parent=this;},resize(w,h){this.width=w;this.height=h;},remove(){this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);nodes.delete(this.id);}};nodes.set(id,n);return n;
}
const rootNode=make('DOCUMENT','root'),p1=make('PAGE','p1'),p2=make('PAGE','p2');rootNode.name='文件 A';rootNode.appendChild(p1);rootNode.appendChild(p2);
const foreign=make('RECTANGLE','foreign');foreign.x=0;p2.appendChild(foreign);
const figma={root:rootNode,fileKey:null,editorType:'figma',showUI(){},ui:{postMessage(m){messages.push(m);}},getNodeByIdAsync:async id=>nodes.get(id),currentPage:p2,
 loadFontAsync:async f=>{loads.push(f);if(failFont)throw Error('font unavailable');},viewport:{scrollAndZoomIntoView(){throw Error('Unexpected focus');}}};
for(const [method,type] of [['createFrame','FRAME'],['createText','TEXT'],['createRectangle','RECTANGLE']])figma[method]=()=>{const n=make(type);created.push(n);figma.currentPage.appendChild(n);return n;};
vm.runInNewContext(code,{figma,__html__:'',console,Date});
const sizes=[];figma.ui.resize=(width,height)=>sizes.push([width,height]);
await figma.ui.onmessage({type:'bridge-panel-mode',mode:'compact'});
await figma.ui.onmessage({type:'bridge-panel-mode',mode:'hub'});
await figma.ui.onmessage({type:'bridge-panel-mode',mode:'invalid'});
assert.deepEqual(sizes,[[400,148],[500,740]]);assert.equal(figma.currentPage,p2);
await figma.ui.onmessage({type:'bridge-ready'});assert.equal(messages.at(-1).type,'figma-info');
Object.defineProperty(figma,'fileKey',{configurable:true,get(){throw Error('fixture initialization failed');}});
await figma.ui.onmessage({type:'bridge-ready'});assert.equal(messages.at(-1).type,'bridge-init-error');assert.match(messages.at(-1).error,/fixture initialization failed/);delete figma.fileKey;
const target={pageId:'p1',scope:'page',aiName:'Codex',bindingId:'test'};
async function execute(command){messages=[];await figma.ui.onmessage({type:'bridge-command',requestId:'test',command});return messages.at(-1);}
assert.equal((await execute({type:'build-section',target,nodes:[{kind:'FRAME',name:'正确页面'}]})).ok,true);
assert.equal(created[0].parent,p1);assert.equal(figma.currentPage,p2);
assert.equal((await execute({type:'get-document-info',target})).result.pageId,'p1');
assert.equal((await execute({type:'update-node',target,nodeId:'foreign',props:{x:100}})).ok,false);assert.equal(foreign.x,0);
assert.equal((await execute({type:'build-section',target,parentId:'p2',nodes:[]})).ok,false);
assert.equal((await execute({type:'design-system',target,action:'variants',parentId:'p1',nodeIds:['foreign']})).ok,false);
assert.equal((await execute({type:'design-system',target,action:'variable'})).ok,false);
assert.equal((await execute({type:'build-section',target,focus:true,nodes:[]})).ok,false);
assert.equal((await execute({type:'update-node',nodeId:'foreign',props:{x:100}})).ok,false);
nodes.delete('p1');assert.equal((await execute({type:'get-document-info',target})).ok,false);nodes.set('p1',p1);
created=[];loads=[];
const texts=Array.from({length:40},(_,i)=>({kind:'TEXT',fontName:{family:'Microsoft YaHei',style:i%2?'Bold':'Regular'},characters:'测试',width:100,height:30}));
assert.equal((await execute({type:'build-section',target,nodes:[{kind:'FRAME',children:texts}]})).ok,true);assert.equal(loads.length,2);assert.equal(created.length,41);
created=[];failFont=true;assert.equal((await execute({type:'build-section',target,nodes:[{kind:'FRAME',children:texts}]})).ok,false);assert.equal(created.length,0);
created=[];failFont=false;assert.equal((await execute({type:'build-section',target,nodes:[{kind:'FRAME',children:[{kind:'BAD'}]}]})).ok,false);assert.ok(created.every(n=>n.removed));
console.log('PASS actual plugin: background page creation, bound document reads, cross-page mutation rejection, missing page, file-wide guard, focus guard, unbound write guard, font preflight, construction rollback');
