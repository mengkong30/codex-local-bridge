import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {figma,page,messages,registry} from './test-api.mjs';

let serial=0;
const target={pageId:page.id,scope:'file',bindingId:'fix-binding',clientId:'fix-client'};
async function command(c){messages.length=0;await figma.ui.onmessage({type:'bridge-command',requestId:'fix-'+(++serial),command:{...c,target}});return structuredClone(messages.findLast(m=>m.type==='bridge-result'));}
async function ok(c){const r=await command(c);assert.equal(r.ok,true,JSON.stringify(r));return r.result;}
const saved={font:figma.loadFontAsync,get:figma.getNodeByIdAsync};
const otherPage=figma.createPage(),untouched=[];
for(let i=0;i<500;i++){const n=figma.createText();otherPage.appendChild(n);n.characters='Unrelated text '+i;n.fontName={family:'Unavailable fixture font',style:'Regular'};untouched.push(n);}
let fontLoads=0,lookups=0,unrelatedWrites=0;
for(const n of untouched)n.setPluginData=()=>{unrelatedWrites++;throw Error('Unrelated node must not be written');};
figma.getNodeByIdAsync=async id=>{lookups++;return saved.get(id);};
figma.loadFontAsync=async()=>{fontLoads++;throw Error('Unrelated unavailable fonts must not block geometry undo');};
const rect=figma.createRectangle();rect.name='Changed rectangle';
const update=await ok({type:'update-node',nodeId:rect.id,props:{rotation:18}});lookups=0;
await ok({type:'undo-operation',operationId:update.operationId});
assert.equal(rect.rotation,0);assert.equal(fontLoads,0);assert.equal(unrelatedWrites,0);assert.ok(lookups<30,'Undo should not perform one asynchronous lookup per unchanged node: '+lookups);
const text=figma.createText();text.characters='Geometry only';
const move=await ok({type:'update-node',nodeId:text.id,props:{x:20}});await ok({type:'undo-operation',operationId:move.operationId});assert.equal(fontLoads,0);assert.equal(text.x,0);
// Changed text must still load every required current/saved font, once per undo.
const fonts=[];figma.loadFontAsync=async f=>{assert.notEqual(f.family,'Unavailable fixture font');fonts.push(JSON.stringify(f));return saved.font(f);};
const text2=figma.createText();text2.characters='Shared font';
const rich=await ok({type:'batch',commands:[text,text2].map(n=>({type:'set-text-ranges',nodeId:n.id,ranges:[{start:0,end:n.characters.length,props:{fontName:{family:'Inter',style:'Bold'}}}]}))});
fonts.length=0;await ok({type:'undo-operation',operationId:rich.operationId});assert.equal(new Set(fonts).size,fonts.length);assert.ok(fonts.length>0&&fonts.length<=2,JSON.stringify(fonts));
for(const n of [text,text2])assert.equal(n.getStyledTextSegments(['fontName'])[0].fontName.style,'Regular');
figma.loadFontAsync=saved.font;figma.getNodeByIdAsync=saved.get;

// Invalid prototype destinations fail before the first step mutates anything.
const frame=figma.createFrame(),nested=figma.createFrame();frame.appendChild(nested);
const reaction=id=>[{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:id,navigation:'NAVIGATE',transition:null}]}];
const invalid=await command({type:'batch',commands:[{type:'update-node',nodeId:rect.id,props:{x:99}},{stepId:'prototype',type:'set-reactions',nodeId:rect.id,reactions:reaction(nested.id)}]});
assert.equal(invalid.ok,false);assert.equal(invalid.details.phase,'preflight');assert.equal(invalid.details.failedStep,'prototype');assert.match(invalid.error,/destinationId.*top-level/);assert.equal(rect.x,0);
for(const thrown of ['',new Error(''),{reason:'Native reaction rejected'}]){
 const original=rect.setReactionsAsync;rect.setReactionsAsync=async()=>{throw thrown;};
 const failed=await command({type:'set-reactions',nodeId:rect.id,reactions:reaction(frame.id)});rect.setReactionsAsync=original;
 assert.equal(failed.ok,false);assert.ok(failed.error.length>20);assert.match(failed.error,new RegExp('set-reactions on node '+rect.id));assert.equal(failed.details.rollback.ok,true);
}
await ok({type:'set-reactions',nodeId:rect.id,reactions:reaction(frame.id)});
const section=figma.createSection(),sectionFrame=figma.createFrame();section.appendChild(sectionFrame);await ok({type:'set-reactions',nodeId:rect.id,reactions:reaction(sectionFrame.id)});
const scroll=reaction(nested.id);scroll[0].actions[0].navigation='SCROLL_TO';await ok({type:'set-reactions',nodeId:rect.id,reactions:scroll});
const conditional=await command({type:'set-reactions',nodeId:rect.id,reactions:[{trigger:{type:'ON_CLICK'},actions:[{type:'CONDITIONAL',conditionalBlocks:[{actions:reaction(nested.id)[0].actions}]}]}]});assert.equal(conditional.ok,false);assert.match(conditional.error,/conditionalBlocks.*destinationId/);
await ok({type:'set-reactions',nodeId:rect.id,reactions:[]});
console.log('PASS runtime fixes: 500 unrelated unavailable fonts, bounded asynchronous undo work, text-only geometry, shared-font rich text restoration, prototype preflight and nonempty native errors');

// Real HTTP service: timeout + connection expiry must not create a second worker.
const port=38907,base='http://127.0.0.1:'+port,delay=ms=>new Promise(r=>setTimeout(r,ms));
const child=spawn(process.execPath,[fileURLToPath(new URL('./bridge-server.mjs',import.meta.url))],{env:{...process.env,BRIDGE_PORT:String(port),BRIDGE_CONNECTION_TTL_MS:'200',BRIDGE_WRITE_TIMEOUT_MS:'100'},stdio:['ignore','ignore','inherit'],windowsHide:true});
async function post(path,p){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p),signal:AbortSignal.timeout(4000)});return {status:r.status,...await r.json()};}
const health=async()=>(await fetch(base+'/health')).json();
try{
 for(let i=0;i<50;i++){try{if((await health()).ok)break;}catch{}await delay(25);}
 const document={fileName:'Late result regression',bridgeVersion:11,panelProtocol:1,pageId:'p',pages:[{id:'p',name:'Test'}]};
 const connectionId=(await post('/hello',{protocolVersion:2,document})).connectionId;
 const clientId=(await post('/clients/register',{name:'Late result',aiName:'Codex'})).clientId;
 const bindingId=(await post('/bindings',{clientId,connectionId,pageId:'p'})).binding.bindingId;
 const pending=post('/command',{clientId,connectionId,bindingId,type:'update-node',nodeId:'fixture',props:{x:1},idempotencyKey:'late-update'});
 const incoming=await(await fetch(base+'/next?connectionId='+connectionId)).json();assert.ok(incoming.requestId);assert.equal((await pending).status,504);
 await delay(250);await health(); // Forces the same retirement path as a real idle UI.
 assert.equal((await post('/hello',{protocolVersion:2,connectionId,document})).status,409);
 assert.equal((await post('/hello',{protocolVersion:2,connectionId,activeRequestId:'wrong',document})).status,409);
 const resumed=await post('/hello',{protocolVersion:2,connectionId,activeRequestId:incoming.requestId,document});assert.equal(resumed.connectionId,connectionId);
 let state=await health();assert.equal(state.connections.length,1);assert.equal(state.connections[0].uncertain,true);assert.equal(state.connections[0].bindings[0].bindingId,bindingId);
 await delay(250);await health();assert.equal((await post('/progress',{connectionId,requestId:incoming.requestId,stage:'restoring',changedNodes:1,totalNodes:500})).status,200);
 assert.equal((await health()).connections[0].connectionId,connectionId);
 await delay(250);await health();const result={id:'fixture',undone:true};
 assert.equal((await post('/result',{connectionId,requestId:incoming.requestId,ok:true,result})).status,200);
 state=await health();assert.equal(state.connections[0].busy,false);assert.equal(state.connections[0].uncertain,false);assert.equal(state.connections[0].bindings[0].bindingId,bindingId);
 const replay=await post('/command',{clientId,connectionId,bindingId,type:'update-node',nodeId:'fixture',props:{x:1},idempotencyKey:'late-update'});assert.equal(replay.duplicate,true);assert.deepEqual(replay.result,result);assert.equal((await health()).connections[0].queueLength,0);
 assert.equal((await post('/hello',{protocolVersion:2,activeRequestId:'unknown',document})).status,409);
 console.log('PASS service fixes: expired in-flight identity resume, wrong/unknown request rejection, late progress/result revival, retained binding and no repeated write');
}finally{child.kill();}
