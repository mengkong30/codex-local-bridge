import assert from 'node:assert/strict';
import {figma,page,messages,registry} from './test-api.mjs';

let serial=0;
const target={pageId:page.id,scope:'page',bindingId:'structure-binding',clientId:'structure-client'};
async function command(c){messages.length=0;await figma.ui.onmessage({type:'bridge-command',requestId:'structure-'+(++serial),command:{...c,target}});return structuredClone(messages.findLast(m=>m.type==='bridge-result'));}
async function ok(c){const r=await command(c);assert.equal(r.ok,true,JSON.stringify(r));return r.result;}
const nodeCount=()=>messages.find(m=>m.stage==='snapshot-saved').nodes;

// Large instance children must not be read or serialized for reorder/move.
const Node=figma.createRectangle().constructor;
const parent=figma.createFrame(),other=figma.createFrame();
const instance=new Node('INSTANCE');parent.appendChild(instance);
let descendantReads=0;
for(let i=0;i<1000;i++){const t=figma.createText();instance.appendChild(t);t.characters='Inherited '+i;t.getPluginData=()=>{descendantReads++;throw Error('Inherited descendant was expanded');};}
const sibling=figma.createRectangle();parent.appendChild(sibling);
const original=parent.children.map(n=>n.id);
const reordered=await ok({type:'reorder-node',nodeId:instance.id,index:1});
assert.ok(nodeCount()<=2);
const history=await ok({type:'operation-history'});
const reorderBytes=history.find(o=>o.operationId===reordered.operationId).bytes;
assert.ok(reorderBytes<50000);
await ok({type:'undo-operation',operationId:reordered.operationId});
assert.deepEqual(parent.children.map(n=>n.id),original);
assert.equal(descendantReads,0);
const moved=await ok({type:'move-node',nodeId:instance.id,parentId:other.id});
assert.ok(nodeCount()<=3);
// Editing a descendant after a move is safe: undo only restores placement.
instance.children[0].characters='User override';
await ok({type:'undo-operation',operationId:moved.operationId});
assert.equal(instance.parent,parent);assert.equal(instance.children[0].characters,'User override');
assert.equal(descendantReads,0);

// Creation snapshots must not visit an unrelated instance subtree.
const created=await ok({type:'create-node',parentId:other.id,node:{kind:'FRAME',name:'Created',children:[{kind:'RECTANGLE',width:20,height:20}]}});
assert.ok(nodeCount()<=2);assert.equal(descendantReads,0);
const child=registry.get(created.id).children[0];child.x=99;
assert.match((await command({type:'undo-operation',operationId:created.operationId})).error,/conflict/);
child.x=0;await ok({type:'undo-operation',operationId:created.operationId});
assert.equal(registry.has(created.id),false);

// A late write failure removes the newly created instance root, not its
// protected inherited child. Emulate Figma's remove restriction independently.
const component=figma.createComponent(),nativeCreate=component.createInstance.bind(component);
component.createInstance=()=>{const n=nativeCreate(),t=figma.createText();n.appendChild(t);t.characters='Override';const remove=t.remove.bind(t);t.remove=()=>{throw Error('Inherited child cannot be removed');};n.remove=()=>{t.remove=remove;Node.prototype.remove.call(n);};return n;};
const marker=figma.createRectangle();other.appendChild(marker);
const nativeInsert=other.insertChild.bind(other);other.insertChild=(i,n)=>{if(n===marker)throw Error('Injected late failure');return nativeInsert(i,n);};
const before=registry.size;
const failed=await command({type:'batch',commands:[{type:'create-node',parentId:other.id,node:{kind:'INSTANCE',componentId:component.id}},{type:'reorder-node',nodeId:marker.id,index:0}]});
other.insertChild=nativeInsert;
assert.equal(failed.ok,false);assert.equal(failed.details.rollback.ok,true,JSON.stringify(failed));assert.equal(registry.size,before);

// Complex batches retain their conservative snapshot, but must also remove only
// created roots when rolling back instances with protected inherited children.
for(const t of instance.children)t.getPluginData=()=>'';
const fullBefore=registry.size;
const fullFailure=await command({type:'batch',commands:[{stepId:'new',type:'create-node',parentId:other.id,node:{kind:'INSTANCE',componentId:component.id}},{type:'update-node',nodeId:{$ref:'new.id'},props:{width:-1}}]});
assert.equal(fullFailure.ok,false);assert.equal(fullFailure.details.rollback.ok,true,JSON.stringify(fullFailure));assert.equal(registry.size,fullBefore);

// Reflow ancestors retain conservative complete dependency snapshots.
const layout=figma.createFrame();layout.layoutMode='HORIZONTAL';const a=figma.createRectangle(),b=figma.createRectangle();layout.appendChild(a);layout.appendChild(b);
const layoutOrder=await ok({type:'reorder-node',nodeId:a.id,index:1});assert.ok(nodeCount()>=3);
b.x=12;assert.match((await command({type:'undo-operation',operationId:layoutOrder.operationId})).error,/conflict/);b.x=0;await ok({type:'undo-operation',operationId:layoutOrder.operationId});
console.log('PASS compact structural snapshots: 1000 inherited descendants read 0 times; reorder history '+reorderBytes+' bytes; placement undo preserves overrides; created-subtree conflict and protected-child rollback pass');

// Crossing a deep snapshot boundary must retain existing descendants in both
// snapshots. Otherwise undo mistakes them for newly created nodes and deletes them.
for(const direction of ['into','out-of'])for(const batched of [false,true]){
 const manual=figma.createFrame(),auto=figma.createFrame();auto.layoutMode='HORIZONTAL';
 const root=figma.createFrame(),nested=figma.createFrame(),leaf=figma.createRectangle();
 root.appendChild(nested);nested.appendChild(leaf);
 const source=direction==='into'?manual:auto,destination=direction==='into'?auto:manual;
 source.appendChild(root);const ids=[root.id,nested.id,leaf.id];
 const move={type:'move-node',nodeId:root.id,parentId:destination.id};
 const result=await ok(batched?{type:'batch',commands:[move]}:move);
 await ok({type:'undo-operation',operationId:result.operationId});
 assert.equal(root.parent,source);assert.equal(nested.parent,root);assert.equal(leaf.parent,nested);
 for(const id of ids)assert.ok(registry.has(id),'Existing descendant lost on '+direction+' undo');
}
console.log('PASS deep-boundary moves: into/out of auto-layout, standalone and batch undo preserve nested descendants');

// The same scope must protect later descendant edits and failed batches.
{
 const manual=figma.createFrame(),auto=figma.createFrame();auto.layoutMode='HORIZONTAL';
 const root=figma.createFrame(),leaf=figma.createRectangle();manual.appendChild(root);root.appendChild(leaf);
 const moved=await ok({type:'move-node',nodeId:root.id,parentId:auto.id});
 leaf.x=42;assert.match((await command({type:'undo-operation',operationId:moved.operationId})).error,/conflict/);
 leaf.x=0;await ok({type:'undo-operation',operationId:moved.operationId});
 const marker=figma.createRectangle();auto.appendChild(marker);
 const insert=auto.insertChild.bind(auto);auto.insertChild=(i,n)=>{if(n===marker)throw Error('Injected boundary failure');return insert(i,n);};
 const failed=await command({type:'batch',commands:[{type:'move-node',nodeId:root.id,parentId:auto.id},{type:'reorder-node',nodeId:marker.id,index:0}]});
 auto.insertChild=insert;
 assert.equal(failed.ok,false);assert.equal(failed.details.rollback.ok,true,JSON.stringify(failed));
 assert.equal(root.parent,manual);assert.ok(registry.has(leaf.id));assert.equal(leaf.parent,root);
}
console.log('PASS deep-boundary descendant conflict protection and failed-batch rollback');
