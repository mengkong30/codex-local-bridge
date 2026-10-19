// Acceptance scenarios for the expanded command surface, using a synthetic API host.
import assert from 'node:assert/strict';
import {figma,page,messages,registry} from './test-runtime.mjs';
const clone=v=>JSON.parse(JSON.stringify(v));
const Node=figma.createRectangle().constructor;
let request=0,groupCalls=0,booleanCalls=0;
const target={pageId:page.id,scope:'page',bindingId:'api-binding',clientId:'api-client'};
const fileTarget={...target,scope:'file'};
async function command(c,t=target){messages.length=0;await figma.ui.onmessage({type:'bridge-command',requestId:'api-'+(++request),command:{...c,target:t}});return clone(messages.findLast(m=>m.type==='bridge-result'));}
async function ok(c,t){const r=await command(c,t);assert.equal(r.ok,true,JSON.stringify(r));return r.result;}
async function rejects(c,re,t){const r=await command(c,t);assert.equal(r.ok,false,JSON.stringify(r));assert.match(r.error,re);return r;}
function enhance(n){
 Object.assign(n,{rotation:0,cornerRadius:0,strokeWeight:1,blendMode:'PASS_THROUGH',locked:false,explicitVariableModes:{},reactions:[],layoutSizingHorizontal:'FIXED',layoutSizingVertical:'FIXED',layoutPositioning:'AUTO',constraints:{horizontal:'MIN',vertical:'MIN'}});
 if(n.type==='FRAME'||n.type==='COMPONENT')Object.assign(n,{layoutWrap:'NO_WRAP',counterAxisSpacing:0,paddingLeft:0,paddingRight:0,paddingTop:0,paddingBottom:0,itemSpacing:0,gridAutoTracks:'NONE',gridItemsPositioning:'MANUAL',gridRowCount:1,gridColumnCount:1,gridRowSizes:[{type:'FLEX',value:1}],gridColumnSizes:[{type:'FLEX',value:1}],gridRowGap:0,gridColumnGap:0});
 if(n.type==='VECTOR')n.vectorNetwork={vertices:[],segments:[]};
 return n;
}
for(const method of ['createFrame','createComponent','createRectangle','createEllipse','createText','createVector']){const original=figma[method];figma[method]=()=>enhance(original());}
for(const [type,method] of Object.entries({LINE:'createLine',POLYGON:'createPolygon',STAR:'createStar',SECTION:'createSection',SLICE:'createSlice'}))figma[method]=()=>{const n=enhance(new Node(type));if(type==='SECTION')n.children=[];page.appendChild(n);return n;};
Object.defineProperty(Node.prototype,'absoluteTransform',{get(){const p=this.parent?.absoluteTransform||[[1,0,0],[0,1,0]];return [[1,0,p[0][2]+this.x],[0,1,p[1][2]+this.y]];}});
Node.prototype.setVectorNetworkAsync=async function(value){this.vectorNetwork=clone(value);};
Node.prototype.setGridChildPosition=function(row,column){this.gridRowAnchorIndex=row;this.gridColumnAnchorIndex=column;};
Node.prototype.setReactionsAsync=async function(reactions){this.reactions=clone(reactions);};
Node.prototype.setExplicitVariableModeForCollection=function(col,modeId){this.explicitVariableModes[col.id]=modeId;};
Node.prototype.clearExplicitVariableModeForCollection=function(col){delete this.explicitVariableModes[col.id];};
Node.prototype.getCSSAsync=async()=>({display:'flex',gap:'12px'});
Node.prototype.getDevResourcesAsync=async()=>[{url:'https://example.com/component',name:'Component source'}];
figma.group=(nodes,parent,index=parent.children.length)=>{groupCalls++;const g=enhance(new Node('GROUP'));parent.insertChild(index,g);for(const n of nodes)g.appendChild(n);return g;};
figma.ungroup=n=>{const nodes=[...n.children],p=n.parent;for(const child of nodes)p.appendChild(child);n.remove();return nodes;};
for(const method of ['union','subtract','intersect','exclude'])figma[method]=(nodes,parent)=>{booleanCalls++;const n=enhance(new Node('BOOLEAN_OPERATION'));parent.appendChild(n);for(const child of nodes)child.remove();return n;};
figma.flatten=(nodes,parent)=>{const n=figma.createVector();parent.appendChild(n);for(const old of nodes)old.remove();return n;};
// Independently emulate Figma's text range splitting, so overlap and undo are exercised.
for(const field of ['fontName','fontSize','fills','textCase','textDecoration','lineHeight','letterSpacing','hyperlink','listOptions','listSpacing','indentation','paragraphIndent','paragraphSpacing']){
 const method='setRange'+field[0].toUpperCase()+field.slice(1);
 Node.prototype[method]=function(start,end,value){
  const original=this.segments||this.getStyledTextSegments(['fontName','fontSize','fills','lineHeight','letterSpacing']);
  const next=[];
  for(const segment of original){const cuts=[segment.start,...[start,end].filter(i=>i>segment.start&&i<segment.end),segment.end].sort((a,b)=>a-b);for(let i=0;i<cuts.length-1;i++){const a=cuts[i],b=cuts[i+1];next.push({...clone(segment),start:a,end:b,characters:this.characters.slice(a,b),...(a>=start&&b<=end?{[field]:clone(value)}:{})});}}
  const styling=s=>JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k])=>!['start','end','characters'].includes(k)).sort(([a],[b])=>a.localeCompare(b))));
  this.segments=[];for(const s of next){const last=this.segments.at(-1);if(last&&last.end===s.start&&styling(last)===styling(s)){last.end=s.end;last.characters+=s.characters;}else this.segments.push(s);}
 };
}
const nativeExport=Node.prototype.exportAsync;
Node.prototype.exportAsync=async function(settings){this.lastExport=clone(settings);if(settings.format==='PDF')return new Uint8Array([37,80,68,70]);if(settings.format==='JPG')return new Uint8Array([255,216,255]);return nativeExport.call(this,settings);};

const capability=await ok({type:'bridge-capabilities'});
await rejects({type:'create-node',node:{kind:'FRAME'}},/explicit controller binding/,null);
assert.equal(capability.version,11);assert.ok(capability.api.nodeProperties.includes('rotation'));assert.ok(capability.api.commands.includes('set-reactions'));
const first=(await ok({type:'create-node',node:{kind:'FRAME',name:'API canvas',width:600,height:400,rotation:12,cornerRadius:16}})).id;
const canvas=registry.get(first);assert.equal(canvas.rotation,12);assert.equal(canvas.cornerRadius,16);
const rect=(await ok({type:'create-node',parentId:first,node:{kind:'RECTANGLE',name:'Editable',width:40,height:30}})).id;
const changed=await ok({type:'update-node',nodeId:rect,props:{rotation:30,cornerRadius:8,strokeWeight:3,effects:[{type:'DROP_SHADOW',color:{r:0,g:0,b:0,a:.2},offset:{x:0,y:4},radius:8,visible:true,blendMode:'NORMAL'}]}});
assert.equal(registry.get(rect).rotation,30);assert.ok(changed.diff.some(d=>d.properties.some(p=>p.property==='rotation')));
await ok({type:'undo-operation',operationId:changed.operationId});assert.equal(registry.get(rect).rotation,0);assert.equal(registry.get(rect).effects.length,0);
const beforeName=registry.get(rect).name;await rejects({type:'update-node',nodeId:rect,props:{name:'Should not change',unknownProperty:true}},/Unsupported update property/);assert.equal(registry.get(rect).name,beforeName);
await ok({type:'update-node',nodeId:rect,props:{width:72}});assert.equal(registry.get(rect).width,72);
await rejects({type:'create-node',node:{kind:'RECTANGLE',unknownProperty:true}},/Unsupported update property/);
const countBefore=registry.size;const preview=await ok({type:'clone-node',nodeId:rect,dryRun:true});assert.equal(preview.writes,0);assert.equal(registry.size,countBefore);
const copied=await ok({type:'clone-node',nodeId:rect,name:'Copy'});assert.equal(registry.size,countBefore+1);await ok({type:'undo-operation',operationId:copied.operationId});assert.equal(registry.has(copied.id),false);
const parent=figma.createFrame();parent.x=140;parent.y=50;canvas.x=30;canvas.y=20;const node=registry.get(rect);node.x=10;node.y=12;const absolute=clone(node.absoluteTransform);
const moved=await ok({type:'move-node',nodeId:rect,parentId:parent.id});assert.deepEqual(clone(node.absoluteTransform),absolute);assert.equal(node.parent,parent);await ok({type:'undo-operation',operationId:moved.operationId});assert.equal(node.parent,canvas);
await rejects({type:'move-node',nodeId:first,parentId:rect},/Parent cannot contain nodes/);
const nested=figma.createFrame();canvas.appendChild(nested);await rejects({type:'move-node',nodeId:first,parentId:nested.id},/descendant/);
const other=figma.createPage(),foreign=figma.createRectangle();other.appendChild(foreign);
await rejects({type:'move-node',nodeId:rect,parentId:other.id},/outside the bound page/);await rejects({type:'delete-node',nodeId:foreign.id,allowNonUndoable:true},/outside the bound page/);
const second=figma.createRectangle();canvas.appendChild(second);const grouped=await ok({type:'group-nodes',nodeIds:[rect,second.id],name:'Group'});assert.equal(groupCalls,1);assert.equal(node.parent.id,grouped.id);await ok({type:'undo-operation',operationId:grouped.operationId});assert.equal(node.parent,canvas);assert.equal(registry.has(grouped.id),false);
const staged=await rejects({type:'batch',commands:[{type:'update-node',nodeId:rect,props:{x:9}},{type:'delete-node',nodeId:second.id}]},/non-undoable/);assert.equal(staged.details.phase,'preflight');assert.equal(registry.has(second.id),true);
await rejects({type:'delete-node',nodeId:second.id},/Cannot reliably undo/);assert.equal(registry.has(second.id),true);const removed=await ok({type:'delete-node',nodeId:second.id,allowNonUndoable:true});assert.equal(removed.undo.supported,false);assert.equal(registry.has(second.id),false);
const shapes=[];for(const kind of ['LINE','POLYGON','STAR','SECTION','SLICE','VECTOR'])shapes.push(await ok({type:'create-node',node:{kind,name:kind}}));assert.deepEqual(shapes.map(s=>s.roots[0].type),['LINE','POLYGON','STAR','SECTION','SLICE','VECTOR']);
await rejects({type:'boolean-operation',operation:'UNION',nodeIds:[shapes[1].id,shapes[2].id]},/Cannot reliably undo/);assert.equal(booleanCalls,0);await ok({type:'boolean-operation',operation:'UNION',nodeIds:[shapes[1].id,shapes[2].id],allowNonUndoable:true});assert.equal(booleanCalls,1);
const textId=(await ok({type:'create-node',node:{kind:'TEXT',fontName:{family:'Inter',style:'Regular'},characters:'Hello world'}})).id;
const text=registry.get(textId);const range=await ok({type:'set-text-ranges',nodeId:textId,ranges:[{start:0,end:5,props:{fontSize:24}},{start:3,end:8,props:{fills:[{type:'SOLID',color:{r:1,g:0,b:0}}]}}]});
assert.equal(text.segments.find(s=>s.start===3).fontSize,24);assert.equal(text.segments.find(s=>s.start===5).fontSize,12);assert.equal(text.segments.find(s=>s.start===5).fills[0].color.r,1);
await ok({type:'undo-operation',operationId:range.operationId});assert.ok(text.segments.every(s=>s.fontSize===12));
const textBefore=clone(text.segments);await rejects({type:'set-text-ranges',nodeId:textId,ranges:[{start:0,end:50,props:{fontSize:40}}]},/UTF-16/);assert.deepEqual(text.segments,textBefore);
await ok({type:'update-node',nodeId:first,props:{layoutMode:'HORIZONTAL',layoutWrap:'WRAP',counterAxisSpacing:12}});assert.equal(canvas.layoutWrap,'WRAP');
await ok({type:'update-node',nodeId:first,props:{layoutMode:'GRID',gridAutoTracks:'NONE',gridRowCount:1,gridColumnCount:1,gridRowSizes:[{type:'FIXED',value:80}],gridColumnSizes:[{type:'FLEX',value:2}],gridRowGap:12,gridColumnGap:16}});assert.equal(canvas.gridRowSizes[0].value,80);assert.equal(canvas.gridColumnGap,16);
await ok({type:'update-node',nodeId:rect,props:{layoutPositioning:'ABSOLUTE',constraints:{horizontal:'STRETCH',vertical:'MAX'}}});assert.equal(node.constraints.horizontal,'STRETCH');
const reactions=[{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:first,navigation:'NAVIGATE',transition:null,preserveScrollPosition:false}]}];
const reaction=await ok({type:'set-reactions',nodeId:rect,reactions});assert.deepEqual(node.reactions,reactions);await ok({type:'undo-operation',operationId:reaction.operationId});assert.deepEqual(node.reactions,[]);
const jpg=await ok({type:'export-node',nodeId:first,format:'JPG',settings:{constraint:{type:'WIDTH',value:1200},useAbsoluteBounds:true}});assert.equal(jpg.mimeType,'image/jpeg');assert.equal(canvas.lastExport.constraint.value,1200);
const pdf=await ok({type:'export-node',nodeId:first,format:'PDF',settings:{contentsOnly:true,colorProfile:'SRGB'}});assert.equal(Buffer.from(pdf.base64,'base64').toString(),'%PDF');
await rejects({type:'export-node',nodeId:first,format:'PDF',settings:{constraint:{type:'SCALE',value:2}}},/Unsupported PDF export option/);
await rejects({type:'export-node',nodeId:first,format:'JPG',settings:{constraint:{type:'WIDTH',value:90000}}},/Invalid export constraint/);
// Variable modes, alias values and explicit node modes use real command sequencing.
const collectionProto=figma.variables.createVariableCollection('Fixture support').constructor.prototype;
let modeSequence=0;const allVariables=new Set();const oldCreateVariable=figma.variables.createVariable;figma.variables.createVariable=(...args)=>{const v=oldCreateVariable(...args);v.description='';allVariables.add(v);return v;};
collectionProto.addMode=function(name){const modeId='mode-'+(++modeSequence);this.modes.push({modeId,name});return modeId;};
collectionProto.removeMode=function(id){this.modes=this.modes.filter(m=>m.modeId!==id);for(const v of allVariables)if(v.variableCollectionId===this.id)delete v.valuesByMode[id];};
const collection=await ok({type:'variable-action',action:'collection-create',name:'Theme'},fileTarget);
const dark=await ok({type:'variable-action',action:'mode-add',collectionId:collection.id,name:'Dark'},fileTarget);
const variable=await ok({type:'variable-action',action:'create',collectionId:collection.id,name:'Accent',dataType:'COLOR',valuesByMode:{[collection.modeId]:{r:1,g:1,b:1,a:1},[dark.modeId]:{r:0,g:0,b:0,a:1}}},fileTarget);assert.equal(variable.valuesByMode[dark.modeId].r,0);
const mode=await ok({type:'set-variable-mode',nodeId:first,collectionId:collection.id,modeId:dark.modeId});assert.equal(canvas.explicitVariableModes[collection.id],dark.modeId);await ok({type:'undo-operation',operationId:mode.operationId});assert.deepEqual(canvas.explicitVariableModes,{});
const added=await ok({type:'variable-action',action:'mode-add',collectionId:collection.id,name:'Preview'},fileTarget);await ok({type:'undo-operation',operationId:added.operationId},fileTarget);assert.ok(!(await figma.variables.getVariableCollectionByIdAsync(collection.id)).modes.some(m=>m.modeId===added.modeId));
await rejects({type:'variable-action',action:'mode-remove',collectionId:collection.id,modeId:dark.modeId},/exclusive file binding/);
await rejects({type:'variable-action',action:'mode-remove',collectionId:collection.id,modeId:dark.modeId},/Cannot reliably undo/,fileTarget);
const paints=new Map(),grids=new Map();let styleSequence=0;
for(const [kind,create,getter,field,map] of [['PAINT','createPaintStyle','getLocalPaintStylesAsync','paints',paints],['GRID','createGridStyle','getLocalGridStylesAsync','layoutGrids',grids]]){
 figma[create]=()=>{const s={id:'new-style-'+(++styleSequence),type:kind,name:'',description:'',[field]:[],remove(){map.delete(this.id);}};map.set(s.id,s);return s;};figma[getter]=async()=>[...map.values()];
}
figma.getStyleByIdAsync=async id=>paints.get(id)||grids.get(id)||null;
const paint=await ok({type:'style-action',action:'create',styleType:'PAINT',name:'Accent',props:{paints:[{type:'SOLID',color:{r:1,g:0,b:0}}]}},fileTarget);assert.equal(paints.get(paint.id).paints[0].color.r,1);await ok({type:'undo-operation',operationId:paint.operationId},fileTarget);assert.equal(paints.has(paint.id),false);
await ok({type:'style-action',action:'create',styleType:'GRID',name:'Grid',props:{layoutGrids:[]}},fileTarget);assert.equal(grids.size,1);
figma.teamLibrary={getAvailableLibraryVariableCollectionsAsync:async()=>[{key:'public-library',name:'Shared'}],getVariablesInLibraryCollectionAsync:async key=>[{key:key+'-accent',name:'Accent'}]};
let imported=false;figma.importComponentByKeyAsync=async key=>{imported=true;const c=figma.createComponent();c.name=key;return c;};
assert.equal((await ok({type:'get-library'})).collections[0].name,'Shared');await rejects({type:'import-library',kind:'component',key:'shared-button',allowNonUndoable:true},/exclusive file binding/);assert.equal(imported,false);await ok({type:'import-library',kind:'component',key:'shared-button',allowNonUndoable:true},fileTarget);assert.equal(imported,true);
const instance=enhance(new Node('INSTANCE'));canvas.appendChild(instance);instance.componentProperties={};let detached=false;
instance.setProperties=p=>instance.componentProperties=clone(p);instance.swapComponent=c=>instance.mainComponent=c;instance.removeOverrides=()=>instance.componentProperties={};instance.detachInstance=()=>{detached=true;return figma.createFrame();};
await rejects({type:'instance-action',action:'set-properties',nodeId:instance.id,properties:{Label:'New'}},/Cannot reliably undo/);await ok({type:'instance-action',action:'set-properties',nodeId:instance.id,properties:{Label:'New'},allowNonUndoable:true});assert.equal(instance.componentProperties.Label,'New');
await ok({type:'instance-action',action:'reset-overrides',nodeId:instance.id,allowNonUndoable:true});assert.deepEqual(instance.componentProperties,{});await ok({type:'instance-action',action:'detach',nodeId:instance.id,allowNonUndoable:true});assert.equal(detached,true);
// The same bridge becomes read-only in Dev Mode; editor-specific APIs stay explicit.
figma.editorType='dev';assert.equal((await ok({type:'get-css',nodeId:first})).css.gap,'12px');assert.equal((await ok({type:'get-dev-resources',nodeId:first})).resources[0].name,'Component source');await rejects({type:'update-node',nodeId:rect,props:{x:1}},/Dev Mode is read-only/);
figma.editorType='figma';await rejects({type:'figjam-action',action:'sticky',text:'Note',allowNonUndoable:true},/requires editor figjam/);
figma.editorType='figjam';figma.createSticky=()=>{const n=enhance(new Node('STICKY'));n.text={characters:'',fontName:{family:'Inter',style:'Regular'}};page.appendChild(n);return n;};
const sticky=await ok({type:'figjam-action',action:'sticky',text:'A note',allowNonUndoable:true});assert.equal(registry.get(sticky.id).text.characters,'A note');
figma.editorType='slides';let slideGrid=[];figma.createSlide=()=>{const n=enhance(new Node('SLIDE'));n.children=[];page.appendChild(n);slideGrid.push([n]);n.isSkippedSlide=false;n.setSlideTransition=t=>n.transition=clone(t);return n;};figma.getSlideGrid=()=>slideGrid;figma.setSlideGrid=g=>slideGrid=g;
const slide=await ok({type:'slides-action',action:'create-slide',allowNonUndoable:true},fileTarget);await ok({type:'slides-action',action:'skip',nodeId:slide.id,skipped:true,allowNonUndoable:true},fileTarget);assert.equal((await ok({type:'get-slides'})).grid[0][0].skipped,true);
figma.editorType='figma';
// Exercise remaining structural/editor adapters and the bounded undo journal.
await rejects({type:'batch',commands:[{type:{$ref:'step.type'},nodeId:rect}]},/literal strings/);
const copies=[];for(let i=0;i<2;i++)copies.push((await ok({type:'clone-node',nodeId:rect})).id);
const extraGroup=await ok({type:'group-nodes',nodeIds:copies});await ok({type:'ungroup-node',nodeId:extraGroup.id,allowNonUndoable:true});assert.equal(registry.has(extraGroup.id),false);
const flat=await ok({type:'flatten-nodes',nodeIds:copies,allowNonUndoable:true});assert.equal(flat.type,'VECTOR');
const vector=registry.get(shapes.at(-1).id);const network={vertices:[{x:0,y:0},{x:20,y:20}],segments:[{start:0,end:1}]};await ok({type:'update-node',nodeId:vector.id,props:{vectorNetwork:network}});assert.deepEqual(vector.vectorNetwork,network);
await ok({type:'apply-auto-layout',nodeId:first,direction:'HORIZONTAL',props:{layoutWrap:'WRAP'},childLayouts:[{nodeId:rect,props:{layoutSizingHorizontal:'FILL'}}]});assert.equal(canvas.layoutWrap,'WRAP');assert.equal(node.layoutSizingHorizontal,'FILL');
const replacement=figma.createComponent();await ok({type:'instance-action',action:'swap',nodeId:instance.id,componentId:replacement.id,allowNonUndoable:true});assert.equal(instance.mainComponent,replacement);
const modeName=await ok({type:'variable-action',action:'mode-rename',collectionId:collection.id,modeId:dark.modeId,name:'Night'},fileTarget);assert.equal(modeName.id,collection.id);await ok({type:'variable-action',action:'mode-remove',collectionId:collection.id,modeId:dark.modeId,allowNonUndoable:true},fileTarget);assert.ok(!(await figma.variables.getVariableCollectionByIdAsync(collection.id)).modes.some(m=>m.modeId===dark.modeId));
figma.editorType='figjam';
figma.createShapeWithText=()=>{const n=figma.createSticky();n.type='SHAPE_WITH_TEXT';n.shapeType='SQUARE';return n;};
figma.createConnector=()=>{const n=enhance(new Node('CONNECTOR'));page.appendChild(n);return n;};
figma.createTable=(rows,columns)=>{const n=enhance(new Node('TABLE'));n.cells=Array.from({length:rows},()=>Array.from({length:columns},()=>({text:{characters:'',fontName:{family:'Inter',style:'Regular'}}})));n.cellAt=(r,c)=>n.cells[r][c];page.appendChild(n);return n;};
const shape=await ok({type:'figjam-action',action:'shape',shapeType:'DIAMOND',text:'Decision',allowNonUndoable:true});assert.equal(registry.get(shape.id).shapeType,'DIAMOND');
const connector=await ok({type:'figjam-action',action:'connector',connectorStart:{endpointNodeId:sticky.id,magnet:'AUTO'},connectorEnd:{endpointNodeId:shape.id,magnet:'AUTO'},connectorLineType:'ELBOWED',allowNonUndoable:true});assert.equal(registry.get(connector.id).connectorEnd.endpointNodeId,shape.id);
await rejects({type:'figjam-action',action:'connector',connectorEnd:{endpointNodeId:foreign.id,magnet:'AUTO'},allowNonUndoable:true},/outside the bound page/);
const table=await ok({type:'figjam-action',action:'table',rows:2,columns:2,allowNonUndoable:true});await ok({type:'figjam-action',action:'table-cell',nodeId:table.id,row:1,column:1,text:'Cell',allowNonUndoable:true});assert.equal(registry.get(table.id).cells[1][1].text.characters,'Cell');
figma.editorType='slides';await ok({type:'slides-action',action:'set-grid',grid:[[slide.id]],allowNonUndoable:true},fileTarget);assert.equal(slideGrid[0][0].id,slide.id);
await ok({type:'slides-action',action:'set-transition',nodeId:slide.id,transition:{style:'DISSOLVE',duration:.3,curve:'EASE_IN_AND_OUT',timing:{type:'ON_CLICK'}},allowNonUndoable:true},fileTarget);assert.equal(registry.get(slide.id).transition.style,'DISSOLVE');
figma.editorType='figma';for(let i=0;i<22;i++)await ok({type:'update-node',nodeId:rect,props:{rotation:i}});const latest=await ok({type:'update-node',nodeId:rect,props:{rotation:99}});await ok({type:'undo-operation',operationId:latest.operationId});assert.equal(node.rotation,21);
console.log('PASS expanded API acceptance: editable properties and undo, topology and absolute positioning, destructive opt-in and batch rejection, new primitives, overlapping rich text, grid/layout, prototype round-trip/undo, JPG/PDF options, multi-mode variables, style snapshots, library scope, instance actions, Dev read-only, FigJam notes and Slides');
export {figma,page,messages,registry};
