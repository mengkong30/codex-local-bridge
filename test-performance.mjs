import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {figma,page,messages,registry} from './test-api.mjs';
let serial=0;
const fileTarget={pageId:page.id,scope:'file',bindingId:'perf-binding',clientId:'perf-client'};
async function command(c,target=fileTarget){messages.length=0;await figma.ui.onmessage({type:'bridge-command',requestId:'perf-'+(++serial),command:{...c,target}});return structuredClone(messages.findLast(m=>m.type==='bridge-result'));}
async function ok(c,target){const r=await command(c,target);assert.equal(r.ok,true,JSON.stringify(r));return r.result;}
const unrelated=figma.createFrame();unrelated.name='5000 unrelated nodes';
let unrelatedReads=0,allPageLoads=0;
for(let i=0;i<5000;i++){const n=figma.createText();unrelated.appendChild(n);n.characters='Unrelated '+i;n.getPluginData=()=>{unrelatedReads++;throw Error('Unrelated subtree was traversed');};}
const originalLoad=figma.loadAllPagesAsync;figma.loadAllPagesAsync=async()=>{allPageLoads++;return originalLoad();};
const frame=figma.createFrame(),rect=figma.createRectangle();frame.appendChild(rect);
const start=performance.now(),updated=await ok({type:'update-node',nodeId:rect.id,props:{rotation:25}});
assert.equal(messages.find(m=>m.type==='bridge-progress'&&m.stage==='snapshot-saved').nodes,1);
unrelated.x=123;await ok({type:'undo-operation',operationId:updated.operationId});assert.equal(rect.rotation,0);assert.equal(unrelated.x,123);
const elapsedMs=performance.now()-start;
const variable=await ok({type:'variable-action',action:'collection-create',name:'Scoped resources'});assert.ok(variable.id);assert.equal(messages.find(m=>m.stage==='snapshot-saved').nodes,0);
const review=await ok({type:'review-layout',nodeId:frame.id});assert.ok(review.reviewId);assert.equal(review.inventory.length,2);
assert.equal(unrelatedReads,0);assert.equal(allPageLoads,0);
// Same-node edits still conflict; unrelated edits are preserved by a scoped undo.
const conflict=await ok({type:'update-node',nodeId:rect.id,props:{x:10}});rect.x=11;assert.match((await command({type:'undo-operation',operationId:conflict.operationId})).error,/conflict/);
rect.x=10;await ok({type:'undo-operation',operationId:conflict.operationId});
// Reflow dependencies must include siblings, rather than snapshotting only the leaf.
const layout=figma.createFrame();layout.layoutMode='HORIZONTAL';const a=figma.createRectangle(),b=figma.createRectangle();layout.appendChild(a);layout.appendChild(b);
const reflow=await ok({type:'update-node',nodeId:a.id,props:{width:150}});assert.equal(messages.find(m=>m.stage==='snapshot-saved').nodes,3);
b.x=8;assert.match((await command({type:'undo-operation',operationId:reflow.operationId})).error,/conflict/);b.x=0;await ok({type:'undo-operation',operationId:reflow.operationId});assert.equal(a.width,100);
for(let i=0;i<24;i++)await ok({type:'update-node',nodeId:rect.id,props:{rotation:i}});
const history=await ok({type:'operation-history'});assert.ok(history.length<=20);assert.ok(history.every(o=>Number.isFinite(o.bytes)&&o.bytes>0&&o.bytes<50000));
assert.equal(unrelatedReads,0);assert.equal(allPageLoads,0);
// A broad structural snapshot is still covered, but yields to a real timer.
const smallPage=figma.createPage();for(let i=0;i<600;i++)smallPage.appendChild(figma.createRectangle());
let ticks=0;const timer=setInterval(()=>ticks++,0);let created;
try{created=await ok({type:'create-node',node:{kind:'FRAME',name:'Cooperative structural test'}},{...fileTarget,pageId:smallPage.id,scope:'page'});}finally{clearInterval(timer);}
assert.ok(ticks>0,'Large traversal must yield to a macrotask');assert.ok(registry.has(created.id));
figma.loadAllPagesAsync=originalLoad;
console.log('PASS performance: 5000 unrelated nodes read 0 times; scoped update/undo '+elapsedMs.toFixed(1)+' ms in synthetic host; resource/review isolation, reflow conflict guard, cached history sizes and cooperative structural scan ('+ticks+' timer ticks)');
