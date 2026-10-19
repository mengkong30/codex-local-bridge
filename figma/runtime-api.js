// Structured Figma API adapters. No evaluation of caller-provided JavaScript.
const apiReads = new Set(API_CONTRACT.reads);
const apiWrites = new Set(API_CONTRACT.writes);
const nodePropertySet = new Set(API_CONTRACT.nodeProperties);
const styleSetters = {fillStyleId:'setFillStyleIdAsync',strokeStyleId:'setStrokeStyleIdAsync',textStyleId:'setTextStyleIdAsync',effectStyleId:'setEffectStyleIdAsync',gridStyleId:'setGridStyleIdAsync'};
const styleTypes = {PAINT:['createPaintStyle','getLocalPaintStylesAsync','paints'],GRID:['createGridStyle','getLocalGridStylesAsync','layoutGrids'],TEXT:['createTextStyle','getLocalTextStylesAsync'],EFFECT:['createEffectStyle','getLocalEffectStylesAsync','effects']};
const actionTypes = API_CONTRACT.actions;
function requireApi(object, method) {
 if (!object || typeof object[method] !== 'function') throw Error('This Figma runtime does not provide '+method);
 return object[method].bind(object);
}
function requireString(value, label) { if(typeof value!=='string'||!value.trim())throw Error(label+' must be a nonempty string');return value; }
function requireObject(value, label) {if(!value||typeof value!=='object'||Array.isArray(value))throw Error(label+' must be an object');return value;}
function indexFor(value,length) {if(!Number.isInteger(value)||value<0||value>length)throw Error('index is outside the destination children');return value;}
async function apiNode(id) {requireString(id,'nodeId');const n=await figma.getNodeByIdAsync(id);if(!n)throw Error('Node not found: '+id);return n;}
function assertEditor(...allowed) {if(!allowed.includes(figma.editorType))throw Error('This command requires editor '+allowed.join(' or ')+'; current editor is '+figma.editorType);}
function assertWritable() {if(figma.editorType==='dev')throw Error('Dev Mode is read-only; open the Design editor to write');}
function fileApiCommand(c) {
 return API_CONTRACT.fileWrites.includes(c.type)||c.type==='instance-action'&&!!c.componentKey||c.type==='create-node'&&!!c.componentKey;
}
function extendedNonUndoable(c) {
 if(['delete-node','ungroup-node','boolean-operation','flatten-nodes'].includes(c.type))return 'This structural operation removes or replaces original node IDs; use Figma native undo for recovery';
 if(c.type==='instance-action')return 'Instance overrides and detached/swapped component internals are not preserved by bridge snapshots';
 if(c.type==='import-library')return 'Imported library assets and their remote relationships cannot be restored reliably';
 if(c.type==='variable-action'&&['collection-remove','mode-remove','remove','import'].includes(c.action))return 'Removed variable/mode IDs and imported library resources cannot be restored reliably';
 if(c.type==='style-action'&&['remove','import'].includes(c.action))return 'Removed style IDs and imported library resources cannot be restored reliably';
 if(['dev-resource-action','slides-action','figjam-action'].includes(c.type))return 'Editor-specific resources, text sublayers and grid metadata require Figma native undo; bridge snapshots do not cover them';
 return null;
}
function apiCapabilities() {
 let teamLibrary=false;try{teamLibrary=!!figma.teamLibrary;}catch{}
 return {protocol:API_CONTRACT.protocol,runtime:API_CONTRACT.runtime,editor:figma.editorType,write:figma.editorType!=='dev',
  commands:[...API_CONTRACT.reads,...API_CONTRACT.writes],nodeProperties:API_CONTRACT.nodeProperties,rangeProperties:API_CONTRACT.rangeProperties,actions:API_CONTRACT.actions,
  createKinds:[...Object.keys(API_CONTRACT.factories),'SVG','INSTANCE'],exportFormats:['PNG','SVG','JPG','PDF'],
  availability:{teamLibrary,sticky:typeof figma.createSticky==='function'&&figma.editorType==='figjam',slides:typeof figma.createSlide==='function'&&figma.editorType==='slides',devResources:typeof figma.currentPage.getDevResourcesAsync==='function'},
  unsupported:['create-new-file','arbitrary-javascript','remote-library-publishing','full-Figma-UI-automation'],
  recovery:'Destructive/editor-specific operations require allowNonUndoable:true and cannot be included in atomic batches'};
}
function validateProps(n, props) {
 requireObject(props,'props');
 for(const [key,value] of Object.entries(props)) {
  if(!nodePropertySet.has(key))throw Error('Unsupported update property: '+key);
  if(n&&!(key in n)&&!['gridPosition'].includes(key))throw Error('Property '+key+' is unavailable on '+n.type+' in this runtime');
  if(['width','height','minWidth','minHeight','maxWidth','maxHeight'].includes(key)&&value!==null&&(!Number.isFinite(value)||value<0))throw Error(key+' must be a nonnegative finite number or null where supported');
  if(['x','y','rotation','fontSize','strokeWeight','opacity'].includes(key)&&!Number.isFinite(value))throw Error(key+' must be finite');
  if(key==='opacity'&&(value<0||value>1))throw Error('opacity must be between 0 and 1');
  if(['gridRowSizes','gridColumnSizes'].includes(key)) {
   if(!Array.isArray(value)||!value.every(t=>t&&['FLEX','FIXED','HUG'].includes(t.type)&&(t.value===undefined||Number.isFinite(t.value)&&t.value>=0)))throw Error(key+' requires valid GridTrackSize entries');
  }
  if(key==='gridPosition'&&(!value||!Number.isInteger(value.row)||!Number.isInteger(value.column)||value.row<0||value.column<0))throw Error('gridPosition requires nonnegative integer row and column');
 }
 if(n)validateTextAlignment(n,props);
}
async function loadNodeFonts(n,props={}) {
 if(n.type!=='TEXT')return;
 const fonts=props.fontName?[props.fontName]:n.getRangeAllFontNames(0,n.characters.length);
 for(const font of new Map(fonts.map(f=>[JSON.stringify(f),f])).values())await figma.loadFontAsync(font);
}
async function applyNodeProps(n,props, restoring=false, fontsLoaded=false) {
 if(!restoring)validateProps(n,props);
 if(!fontsLoaded)await loadNodeFonts(n,props);
 // Establish layout and grid track counts before track/child sizing.
 const order=['layoutMode','gridItemsPositioning','gridAutoTracks','gridRowCount','gridColumnCount','fontName','characters'];
 const deferred=new Set(['width','height','gridRowSizes','gridColumnSizes','gridPosition','vectorNetwork',...Object.keys(styleSetters)]);
 const keys=[...order.filter(k=>props[k]!==undefined),...Object.keys(props).filter(k=>!order.includes(k))];
 for(const key of keys)if(!deferred.has(key))n[key]=cloneValue(props[key]);
 if(props.width!==undefined||props.height!==undefined)n.resize(props.width??n.width,props.height??n.height);
 for(const key of ['gridRowSizes','gridColumnSizes'])if(props[key]!==undefined) {
  const tracks=n[key];if(tracks.length!==props[key].length)throw Error(key+' length must match its track count');
  for(let i=0;i<tracks.length;i++){tracks[i].type=props[key][i].type;if(props[key][i].value!==undefined)tracks[i].value=props[key][i].value;}
 }
 if(props.gridPosition)requireApi(n,'setGridChildPosition')(props.gridPosition.row,props.gridPosition.column);
 if(props.vectorNetwork!==undefined)await requireApi(n,'setVectorNetworkAsync')(props.vectorNetwork);
 for(const [key,method] of Object.entries(styleSetters))if(props[key]!==undefined)await requireApi(n,method)(props[key]);
}
function specProps(spec) {
 const props={};for(const [key,value] of Object.entries(spec))if(!['kind','children','svg','componentId','componentKey','key'].includes(key))props[key]=value;
 validateProps(null,props);return props;
}
function validateSpec(spec) {
 requireObject(spec,'node specification');
 if(!API_CONTRACT.factories[spec.kind]&&!['SVG','INSTANCE'].includes(spec.kind))throw Error('Unsupported kind: '+spec.kind);
 const props=specProps(spec);
 if(spec.kind==='TEXT'&&!props.fontName)throw Error('Text fontName required');
 if(spec.kind==='SVG')requireString(spec.svg,'svg');
 if(spec.componentKey)throw Error('Import library components with import-library first, then use componentId in node specifications');
 if(spec.kind==='INSTANCE'&&!spec.componentId)throw Error('componentId required');
 if(spec.children!==undefined&&!Array.isArray(spec.children))throw Error('children must be an array');
 for(const child of spec.children||[])validateSpec(child);
}
async function buildApiNodes(c,progress,page) {
 const parent=c.parentId?await apiNode(c.parentId):page;
 if(!Array.isArray(parent.children)||typeof parent.appendChild!=='function')throw Error('Parent cannot contain nodes');
 const nodes=c.type==='create-node'?[c.node||c.spec]:c.nodes;
 if(!Array.isArray(nodes))throw Error('nodes array required');
 const fonts=new Map();function collect(s){validateSpec(s);if(s.kind==='TEXT')fonts.set(JSON.stringify(s.fontName),s.fontName);for(const child of s.children||[])collect(child);}
 nodes.forEach(collect);
 for(const font of fonts.values()){progress('loading-font',{font});await figma.loadFontAsync(font);}
 const created=[];
 async function build(s,p) {
  let n;
  if(s.kind==='SVG')n=requireApi(figma,'createNodeFromSvg')(s.svg);
  else if(s.kind==='INSTANCE') {
   const source=s.componentKey?await requireApi(figma,'importComponentByKeyAsync')(s.componentKey):await apiNode(s.componentId);
   if(source.type!=='COMPONENT')throw Error('Reference is not a component');n=source.createInstance();
  } else n=requireApi(figma,API_CONTRACT.factories[s.kind])();
  created.push(n);p.appendChild(n);await applyNodeProps(n,specProps(s),false,true);
  if(created.length===1||created.length%20===0)progress('building',{created:created.length,nodeName:n.name});
  for(const child of s.children||[])await build(child,n);return n;
 }
 try {
  const roots=[];for(const s of nodes)roots.push(await build(s,parent));
  if(c.focus&&figma.currentPage.id===page.id){page.selection=roots;figma.viewport.scrollAndZoomIntoView(roots);}
  return {id:roots.length===1?roots[0].id:undefined,roots:roots.map(n=>({id:n.id,name:n.name,type:n.type,width:n.width,height:n.height})),created:created.length};
 }catch(error){for(const n of created.reverse())if(!n.removed)n.remove();throw error;}
}
function multiplyTransform(a,b){return [[a[0][0]*b[0][0]+a[0][1]*b[1][0],a[0][0]*b[0][1]+a[0][1]*b[1][1],a[0][0]*b[0][2]+a[0][1]*b[1][2]+a[0][2]],[a[1][0]*b[0][0]+a[1][1]*b[1][0],a[1][0]*b[0][1]+a[1][1]*b[1][1],a[1][0]*b[0][2]+a[1][1]*b[1][2]+a[1][2]]];}
function inverseTransform(m){const d=m[0][0]*m[1][1]-m[0][1]*m[1][0];if(Math.abs(d)<1e-10)throw Error('Destination transform is singular');return [[m[1][1]/d,-m[0][1]/d,(m[0][1]*m[1][2]-m[1][1]*m[0][2])/d],[-m[1][0]/d,m[0][0]/d,(m[1][0]*m[0][2]-m[0][0]*m[1][2])/d]];}
function moveApiNode(n,parent,index,preserve=true,absolute=n.absoluteTransform) {
 if(!Array.isArray(parent.children)||typeof parent.insertChild!=='function')throw Error('Parent cannot contain nodes');
 for(let p=parent;p;p=p.parent)if(p.id===n.id)throw Error('Cannot move a node into itself or a descendant');
 const relative=preserve&&absolute?multiplyTransform(inverseTransform(parent.absoluteTransform||[[1,0,0],[0,1,0]]),absolute):null;
 parent.insertChild(indexFor(index??parent.children.length,parent.children.length),n);
 if(relative)n.relativeTransform=relative;
}
async function apiNodes(ids) {
 if(!Array.isArray(ids)||!ids.length||ids.length>1000||new Set(ids).size!==ids.length)throw Error('nodeIds requires 1–1000 distinct IDs');
 return Promise.all(ids.map(apiNode));
}
async function planApiCommand(c) {
 assertWritable();
 if(actionTypes[c.type]&&!actionTypes[c.type].includes(c.action))throw Error('Unsupported '+c.type+' action: '+c.action);
 if(c.type==='create-node'){validateSpec(c.node||c.spec);if(c.parentId&&!('appendChild' in await apiNode(c.parentId)))throw Error('Parent cannot contain nodes');}
 if(['delete-node','clone-node','move-node','reorder-node','ungroup-node','set-text-ranges','instance-action','set-variable-mode','set-reactions','dev-resource-action'].includes(c.type)) {
  const n=await apiNode(c.nodeId);
  if(['PAGE','DOCUMENT','SLIDE_GRID'].includes(n.type))throw Error('This operation does not accept document/page/grid roots');
  if(c.type==='delete-node'&&n.locked&&!c.allowLocked)throw Error('Node is locked; explicitly set allowLocked:true if intended');
  if(c.type==='clone-node')requireApi(n,'clone');
  if(c.type==='move-node'){const p=await apiNode(c.parentId);if(!Array.isArray(p.children)||typeof p.insertChild!=='function')throw Error('Parent cannot contain nodes');for(let a=p;a;a=a.parent)if(a.id===n.id)throw Error('Cannot move a node into itself or a descendant');}
  if(c.type==='reorder-node')indexFor(c.index,n.parent.children.length-1);
  if(c.type==='ungroup-node'&&n.type!=='GROUP')throw Error('ungroup-node requires a GROUP');
  if(c.type==='set-text-ranges')await validateTextRanges(n,c.ranges);
  if(c.type==='instance-action') {
   if(n.type!=='INSTANCE')throw Error('instance-action requires an INSTANCE');
   if(c.action==='set-properties')requireObject(c.properties,'properties');
   if(c.action==='swap'&&!c.componentId&&!c.componentKey)throw Error('swap requires componentId or componentKey');
  }
  if(c.type==='set-reactions'){if(!Array.isArray(c.reactions))throw Error('reactions must be an array');requireApi(n,'setReactionsAsync');}
  if(c.type==='set-variable-mode'){requireString(c.collectionId,'collectionId');if(!c.clear)requireString(c.modeId,'modeId');}
 }
 if(['group-nodes','boolean-operation','flatten-nodes'].includes(c.type)) {
  const nodes=await apiNodes(c.nodeIds);const parent=c.parentId?await apiNode(c.parentId):nodes[0].parent;
  if(!parent||!('appendChild' in parent))throw Error('Parent cannot contain nodes');
  for(let p=parent;p;p=p.parent)if(nodes.includes(p))throw Error('Group destination cannot be one of the source nodes or their descendants');
  for(const n of nodes)for(let p=n.parent;p;p=p.parent)if(nodes.includes(p))throw Error('Node list cannot contain both a parent and its descendant');
  if(c.type==='boolean-operation'&&!['UNION','SUBTRACT','INTERSECT','EXCLUDE'].includes(c.operation))throw Error('Unsupported boolean operation');
  const method=c.type==='group-nodes'?'group':c.type==='flatten-nodes'?'flatten':c.operation.toLowerCase();requireApi(figma,method);
 }
 if(c.type==='variable-action') {
  assertEditor('figma');
  if(['collection-create','mode-add','mode-rename','collection-rename','create'].includes(c.action))requireString(c.name,'name');
  if(c.action==='create'&&!['COLOR','FLOAT','STRING','BOOLEAN'].includes(c.dataType))throw Error('Invalid variable dataType');
  if(c.action==='import')requireString(c.key,'key');
  if(c.action.startsWith('mode-'))requireString(c.collectionId,'collectionId');
  if(c.action==='create'||c.action.startsWith('mode-')||['collection-rename','collection-remove'].includes(c.action)){const col=await figma.variables.getVariableCollectionByIdAsync(c.collectionId);if(!col)throw Error('Variable collection missing');if(['mode-rename','mode-remove'].includes(c.action)&&!col.modes.some(m=>m.modeId===c.modeId))throw Error('Mode does not belong to the variable collection');}
  if(['update','remove'].includes(c.action)&&!await figma.variables.getVariableByIdAsync(c.variableId))throw Error('Variable missing');
  if(c.valuesByMode)requireObject(c.valuesByMode,'valuesByMode');
  if(c.codeSyntax)for(const key of Object.keys(c.codeSyntax))if(!['WEB','ANDROID','iOS'].includes(key))throw Error('Unsupported code syntax platform');
 }
 if(c.type==='import-library') {
  assertEditor('figma');requireString(c.key,'key');
  const methods={component:'importComponentByKeyAsync','componentSet':'importComponentSetByKeyAsync',style:'importStyleByKeyAsync',variable:'importVariableByKeyAsync'};
  if(!methods[c.kind])throw Error('Library kind must be component, componentSet, style or variable');requireApi(c.kind==='variable'?figma.variables:figma,methods[c.kind]);
 }
 if(c.type==='style-action') {
  assertEditor('figma');
  if(c.action==='create'){if(!styleTypes[c.styleType])throw Error('styleType must be PAINT, GRID, TEXT or EFFECT');requireString(c.name,'name');requireApi(figma,styleTypes[c.styleType][0]);}
  if(c.action==='import')requireString(c.key,'key');
  if(c.props)validateStyleProps(c.props);
  if(['update','remove'].includes(c.action)){const style=await requireApi(figma,'getStyleByIdAsync')(c.styleId);if(!style)throw Error('Style missing');if(c.props)for(const key of Object.keys(c.props))if(!(key in style))throw Error('Property '+key+' is unavailable on this style');}
 }
 if(c.type==='figjam-action') {
  assertEditor('figjam');
  const methods={sticky:'createSticky',shape:'createShapeWithText',connector:'createConnector',table:'createTable'};
  if(methods[c.action])requireApi(figma,methods[c.action]);
  if(c.action==='table'&&(!Number.isInteger(c.rows)||!Number.isInteger(c.columns)||c.rows<1||c.columns<1||c.rows*c.columns>1000))throw Error('table requires positive rows/columns, at most 1000 cells');
  if(c.text!==undefined&&typeof c.text!=='string')throw Error('text must be a string');
  if(c.action==='table-cell'&&typeof c.text!=='string')throw Error('table-cell requires text');
  if(c.props)validateProps(null,c.props);
 }
 if(c.type==='slides-action') {assertEditor('slides');if(c.props)validateProps(null,c.props);if(c.action==='create-slide')requireApi(figma,'createSlide');if(c.action==='create-row')requireApi(figma,'createSlideRow');if(c.action==='set-grid'&&!Array.isArray(c.grid))throw Error('grid must be an array of rows of slide IDs');}
 return {type:c.type,action:c.action,fields:Object.keys(c).filter(k=>k!=='target'),rollback:extendedNonUndoable(c)?'unsupported':'supported',warning:extendedNonUndoable(c)};
}
async function validateTextRanges(n,ranges) {
 if(n.type!=='TEXT')throw Error('Text ranges require a TEXT node');
 if(!Array.isArray(ranges)||!ranges.length)throw Error('ranges must be a nonempty array');
 for(const range of ranges) {
  if(!Number.isInteger(range.start)||!Number.isInteger(range.end)||range.start<0||range.end<=range.start||range.end>n.characters.length)throw Error('Text range must use valid UTF-16 start/end offsets');
  requireObject(range.props,'range props');
  for(const key of Object.keys(range.props)) {
   if(!API_CONTRACT.rangeProperties.includes(key))throw Error('Unsupported text range property: '+key);
   const suffix=key[0].toUpperCase()+key.slice(1);if(typeof n['setRange'+suffix+'Async']!=='function'&&typeof n['setRange'+suffix]!=='function')throw Error('This runtime does not support range '+key);
  }
 }
}
function validateStyleProps(props) {
 requireObject(props,'style props');const allowed=['name','description','paints','effects','layoutGrids','fontName','fontSize','lineHeight','letterSpacing','paragraphSpacing','paragraphIndent','textCase','textDecoration'];
 for(const k of Object.keys(props))if(!allowed.includes(k))throw Error('Unsupported style property: '+k);
}
function snapshotStyle(style) {
 const props=['name','description','paints','effects','layoutGrids','fontName','fontSize','lineHeight','letterSpacing','paragraphSpacing','paragraphIndent','textCase','textDecoration'];
 return {id:style.id,...Object.fromEntries(props.filter(k=>style[k]!==undefined).map(k=>[k,cloneValue(style[k])]))};
}
async function executeVariableAction(c) {
 const v=figma.variables;
 if(c.action==='collection-create'){const col=v.createVariableCollection(c.name);if(c.modeName)col.renameMode(col.defaultModeId,c.modeName);return {id:col.id,modeId:col.defaultModeId};}
 if(c.action==='import'){const value=await requireApi(v,'importVariableByKeyAsync')(c.key);return {id:value.id,name:value.name};}
 if(c.action.startsWith('collection-')||c.action.startsWith('mode-')) {
  const col=await v.getVariableCollectionByIdAsync(c.collectionId);if(!col)throw Error('Variable collection missing');
  if(c.action==='collection-rename')col.name=c.name;
  if(c.action==='collection-remove')col.remove();
  if(c.action==='mode-add')return {id:col.id,modeId:col.addMode(c.name)};
  if(c.action==='mode-rename')col.renameMode(c.modeId,c.name);
  if(c.action==='mode-remove')col.removeMode(c.modeId);
  return {id:col.id};
 }
 let variable;
 if(c.action==='create'){const col=await v.getVariableCollectionByIdAsync(c.collectionId);if(!col)throw Error('Variable collection missing');variable=v.createVariable(c.name,col,c.dataType);}
 else variable=await v.getVariableByIdAsync(c.variableId);
 if(!variable)throw Error('Variable missing');
 if(c.action==='remove'){variable.remove();return {id:variable.id,removed:true};}
 if(c.name!==undefined)variable.name=c.name;
 if(c.description!==undefined)variable.description=c.description;
 if(c.scopes!==undefined)variable.scopes=c.scopes;
 if(c.codeSyntax)for(const [platform,syntax] of Object.entries(c.codeSyntax)){if(!['WEB','ANDROID','iOS'].includes(platform))throw Error('Unsupported code syntax platform');if(syntax===null)variable.removeVariableCodeSyntax(platform);else variable.setVariableCodeSyntax(platform,syntax);}
 const col=await v.getVariableCollectionByIdAsync(variable.variableCollectionId);
 const values=c.valuesByMode||('value' in c?{[c.modeId||col.defaultModeId]:c.value}:{});
 for(const [modeId,value] of Object.entries(values)){if(!col.modes.some(m=>m.modeId===modeId))throw Error('Mode does not belong to the variable collection');variable.setValueForMode(modeId,value);}
 return {id:variable.id,name:variable.name,valuesByMode:cloneValue(variable.valuesByMode)};
}
async function executeStyleAction(c) {
 let style;
 if(c.action==='import')style=await requireApi(figma,'importStyleByKeyAsync')(c.key);
 else if(c.action==='create')style=requireApi(figma,styleTypes[c.styleType][0])();
 else style=await requireApi(figma,'getStyleByIdAsync')(c.styleId);
 if(!style)throw Error('Style missing');
 if(c.action==='remove'){style.remove();return {id:style.id,removed:true};}
 const props={...(c.props||{}),...(c.name!==undefined?{name:c.name}:{})};validateStyleProps(props);
 if(props.fontName)await figma.loadFontAsync(props.fontName);
 for(const [key,value] of Object.entries(props)){if(!(key in style))throw Error('Property '+key+' is unavailable on this style');style[key]=value;}
 return {id:style.id,name:style.name,type:style.type};
}
async function executeFigjam(c) {
 let n;
 if(c.action==='table-cell') {
  n=await apiNode(c.nodeId);if(n.type!=='TABLE')throw Error('Expected a TABLE');
  const cell=n.cellAt(c.row,c.column);if(!cell)throw Error('Table cell missing');
  await loadEditorText(cell.text,c.fontName);cell.text.characters=c.text;return {id:n.id,row:c.row,column:c.column};
 }
 const methods={sticky:'createSticky',shape:'createShapeWithText',connector:'createConnector',table:'createTable'};
 n=c.action==='table'?requireApi(figma,methods[c.action])(c.rows,c.columns):requireApi(figma,methods[c.action])();
 const parent=c.parentId?await apiNode(c.parentId):await commandPage(c);parent.appendChild(n);
 try {
  if(c.props)await applyNodeProps(n,c.props);
  if(c.shapeType!==undefined)n.shapeType=c.shapeType;
  if(c.action==='connector')for(const key of ['connectorStart','connectorEnd','connectorLineType','connectorStartStrokeCap','connectorEndStrokeCap'])if(c[key]!==undefined)n[key]=c[key];
  if(c.text!==undefined){const text=n.text;if(!text)throw Error('This node has no text sublayer');await loadEditorText(text,c.fontName);text.characters=c.text;}
  return {id:n.id,type:n.type};
 }catch(error){if(!n.removed)n.remove();throw error;}
}
async function loadEditorText(text,fontName) {
 const fonts=fontName?[fontName]:typeof text.getRangeAllFontNames==='function'?text.getRangeAllFontNames(0,text.characters.length):[text.fontName];
 for(const font of fonts)await figma.loadFontAsync(font);
 if(fontName)text.fontName=fontName;
}
async function planAutoLayout(c) {
 const n=await apiNode(c.nodeId);if(!('layoutMode' in n))throw Error('Auto layout requires a frame/component');
 if(c.props)validateProps(n,c.props);
 for(const child of c.childLayouts||[]){const node=await apiNode(child.nodeId);if(node.parent?.id!==n.id)throw Error('childLayouts only accepts direct children of the target');validateProps(node,child.props);}
 return {type:c.type,nodeId:n.id,fields:Object.keys(c.props||{}),children:(c.childLayouts||[]).map(child=>child.nodeId),rollback:'supported'};
}
async function executeSlides(c) {
 if(c.action==='create-slide'){const n=figma.createSlide(c.row,c.column);if(c.props)await applyNodeProps(n,c.props);return {id:n.id,type:n.type};}
 if(c.action==='create-row'){const n=figma.createSlideRow(c.row);return {id:n.id,type:n.type};}
 if(c.action==='set-grid'){const grid=[];for(const ids of c.grid){if(!Array.isArray(ids))throw Error('Each grid row must be an array');const row=[];for(const id of ids){const n=await apiNode(id);if(n.type!=='SLIDE')throw Error('Grid entries must be slides');row.push(n);}grid.push(row);}figma.setSlideGrid(grid);return {grid:c.grid};}
 const n=await apiNode(c.nodeId);if(n.type!=='SLIDE')throw Error('Expected a SLIDE');
 if(c.action==='skip')n.isSkippedSlide=!!c.skipped;
 if(c.action==='set-transition')n.setSlideTransition(c.transition);
 return {id:n.id};
}
async function executeApiCommand(c,progress=()=>{}) {
 if(c.type==='get-editor-info')return apiCapabilities();
 if(c.type==='get-css')return {nodeId:c.nodeId,css:await requireApi(await apiNode(c.nodeId),'getCSSAsync')()};
 if(c.type==='get-dev-resources')return {resources:await requireApi(await apiNode(c.nodeId),'getDevResourcesAsync')({includeChildren:!!c.includeChildren})};
 if(c.type==='get-slides'){assertEditor('slides');return {grid:requireApi(figma,'getSlideGrid')().map(row=>row.map(n=>({id:n.id,name:n.name,skipped:n.isSkippedSlide}))) };}
 if(c.type==='get-library') {
  if(c.collectionKey)return {variables:await requireApi(figma.teamLibrary,'getVariablesInLibraryCollectionAsync')(c.collectionKey)};
  return {collections:await requireApi(figma.teamLibrary,'getAvailableLibraryVariableCollectionsAsync')()};
 }
 if(c.type==='import-library') {
  const methods={component:'importComponentByKeyAsync',componentSet:'importComponentSetByKeyAsync',style:'importStyleByKeyAsync',variable:'importVariableByKeyAsync'};
  const asset=await requireApi(c.kind==='variable'?figma.variables:figma,methods[c.kind])(c.key);return {id:asset.id,name:asset.name,type:asset.type||asset.resolvedType};
 }
 if(c.type==='create-node')return buildApiNodes(c,progress,await commandPage(c));
 if(c.type==='set-text-ranges') {
  const n=await apiNode(c.nodeId);await validateTextRanges(n,c.ranges);await loadNodeFonts(n);
  for(const range of c.ranges)if(range.props.fontName)await figma.loadFontAsync(range.props.fontName);
  for(const range of c.ranges)for(const [key,value] of Object.entries(range.props)){const suffix=key[0].toUpperCase()+key.slice(1),method=typeof n['setRange'+suffix+'Async']==='function'?'setRange'+suffix+'Async':'setRange'+suffix;await n[method](range.start,range.end,value);}
  return {id:n.id,ranges:c.ranges.length};
 }
 if(c.type==='variable-action')return executeVariableAction(c);
 if(c.type==='style-action')return executeStyleAction(c);
 if(c.type==='figjam-action')return executeFigjam(c);
 if(c.type==='slides-action')return executeSlides(c);
 if(['group-nodes','boolean-operation','flatten-nodes'].includes(c.type)) {
  const nodes=await apiNodes(c.nodeIds),parent=c.parentId?await apiNode(c.parentId):nodes[0].parent;
  const method=c.type==='group-nodes'?'group':c.type==='flatten-nodes'?'flatten':c.operation.toLowerCase();
  const n=requireApi(figma,method)(nodes,parent,c.index);if(c.name)n.name=c.name;return {id:n.id,type:n.type};
 }
 const n=await apiNode(c.nodeId);
 if(c.type==='delete-node'){n.remove();return {id:c.nodeId,removed:true};}
 if(c.type==='clone-node'){const absolute=n.absoluteTransform,copy=n.clone();moveApiNode(copy,c.parentId?await apiNode(c.parentId):n.parent,c.index,c.preserveAbsolute!==false,absolute);if(c.name)copy.name=c.name;return {id:copy.id,type:copy.type};}
 if(c.type==='move-node'){moveApiNode(n,await apiNode(c.parentId),c.index,c.preserveAbsolute!==false);return {id:n.id,parentId:n.parent.id};}
 if(c.type==='reorder-node'){n.parent.insertChild(c.index,n);return {id:n.id,index:n.parent.children.indexOf(n)};}
 if(c.type==='ungroup-node')return {ids:requireApi(figma,'ungroup')(n).map(child=>child.id)};
 if(c.type==='instance-action') {
  if(c.action==='set-properties')n.setProperties(c.properties);
  if(c.action==='swap'){const component=c.componentKey?await figma.importComponentByKeyAsync(c.componentKey):await apiNode(c.componentId);if(component.type!=='COMPONENT')throw Error('Expected component');n.swapComponent(component);}
  if(c.action==='detach'){const frame=n.detachInstance();return {id:frame.id,type:frame.type};}
  if(c.action==='reset-overrides')requireApi(n,'removeOverrides')();
  return {id:n.id};
 }
 if(c.type==='set-variable-mode') {
  const col=await figma.variables.getVariableCollectionByIdAsync(c.collectionId);if(!col)throw Error('Variable collection missing');
  if(c.clear)requireApi(n,'clearExplicitVariableModeForCollection')(col);else {if(!col.modes.some(m=>m.modeId===c.modeId))throw Error('Mode does not belong to collection');requireApi(n,'setExplicitVariableModeForCollection')(col,c.modeId);}
  return {id:n.id,explicitVariableModes:cloneValue(n.explicitVariableModes)};
 }
 if(c.type==='set-reactions'){await n.setReactionsAsync(c.reactions);return {id:n.id,reactions:cloneValue(n.reactions)};}
 if(c.type==='dev-resource-action') {
  if(c.action==='add')await requireApi(n,'addDevResourceAsync')(c.url,c.name);
  if(c.action==='edit')await requireApi(n,'editDevResourceAsync')(c.url,c.value);
  if(c.action==='remove')await requireApi(n,'deleteDevResourceAsync')(c.url);
  return {id:n.id};
 }
 throw Error('Unsupported API command: '+c.type);
}
function exportOptions(c) {
 if(c.settings!==undefined)requireObject(c.settings,'export settings');
 const format=String(c.format||c.settings?.format||'SVG').toUpperCase();
 if(!['PNG','SVG','JPG','PDF'].includes(format))throw Error('Supported formats: PNG, SVG, JPG, PDF');
 const allowed=new Set(['contentsOnly','useAbsoluteBounds','suffix','colorProfile',...(['PNG','JPG'].includes(format)?['constraint']:[]),...(format==='SVG'?['svgOutlineText','svgIdAttribute','svgSimplifyStroke']:[])]);
 const options={format};for(const [key,value] of Object.entries(c.settings||{})){if(key==='format')continue;if(!allowed.has(key))throw Error('Unsupported '+format+' export option: '+key);options[key]=value;}
 if(['PNG','JPG'].includes(format)) {
  options.constraint ||= {type:'SCALE',value:c.scale??1};
  const {type,value}=options.constraint;if(!['SCALE','WIDTH','HEIGHT'].includes(type)||!Number.isFinite(value)||value<=0||(type==='SCALE'?value>4:value>16384))throw Error('Invalid export constraint (scale <=4; width/height <=16384)');
 }
 return options;
}
