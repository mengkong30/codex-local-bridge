// In-memory transaction journal. Reopening the plugin intentionally clears undo history.
const operationHistory = new Map();
const SNAPSHOT_LIMIT = 24 * 1024 * 1024;
const snapshotFields = ['name','visible','locked','x','y','width','height','relativeTransform','fills','strokes','strokeWeight','strokeAlign','opacity','effects','cornerRadius','topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius','clipsContent','fontName','fontSize','characters','textAlignHorizontal','textAlignVertical','textAutoResize','lineHeight','letterSpacing','layoutMode','layoutSizingHorizontal','layoutSizingVertical','layoutGrow','layoutAlign','layoutPositioning','paddingLeft','paddingRight','paddingTop','paddingBottom','itemSpacing','primaryAxisAlignItems','counterAxisAlignItems','primaryAxisSizingMode','counterAxisSizingMode','description','textStyleId','effectStyleId','boundVariables','vectorPaths','textTruncation','maxLines','minWidth','minHeight','maxWidth','maxHeight','constraints'];
const segmentFields=['fontName','fontSize','fills','lineHeight','letterSpacing','textDecoration','textCase','textStyleId','fillStyleId','hyperlink','listOptions','listSpacing','indentation','paragraphIndent','paragraphSpacing'];
const cloneValue = v => v === undefined || typeof v === 'symbol' ? undefined : JSON.parse(JSON.stringify(v));
const canonical = v => JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
function nodePath(n){const parts=[];for(let p=n;p&&p.type!=='DOCUMENT';p=p.parent)parts.unshift(p.name);return parts.join(' / ');}
function nodeSnapshot(n){
 const props={};for(const key of snapshotFields){try{const value=cloneValue(n[key]);if(value!==undefined)props[key]=value;}catch(e){throw Error('Cannot snapshot '+key+' on '+n.id+': '+e.message);}}
 return {id:n.id,type:n.type,parentId:n.parent?.id,index:n.parent?.children?.indexOf(n),path:nodePath(n),props,logicalKey:n.getPluginData?.('bridge.logicalKey')||'',segments:n.type==='TEXT'?cloneValue(n.getStyledTextSegments(segmentFields)):undefined};
}
async function captureState(command,enforceLimit=true){
 const page=await commandPage(command),file=command.target?.scope==='file';
 if(file)await figma.loadAllPagesAsync();
 const pages=file?figma.root.children:[page],nodes=[];
 function visit(n){nodes.push(nodeSnapshot(n));for(const child of n.children||[])visit(child);}pages.forEach(visit);
 const state={nodes};
 if(file){
  state.collections=(await figma.variables.getLocalVariableCollectionsAsync()).map(v=>({id:v.id,name:v.name,modes:cloneValue(v.modes)}));
  state.variables=(await figma.variables.getLocalVariablesAsync()).map(v=>({id:v.id,name:v.name,scopes:cloneValue(v.scopes),codeSyntax:cloneValue(v.codeSyntax),valuesByMode:cloneValue(v.valuesByMode)}));
  state.textStyles=(await figma.getLocalTextStylesAsync()).map(v=>({id:v.id,name:v.name,fontName:cloneValue(v.fontName),fontSize:v.fontSize,lineHeight:cloneValue(v.lineHeight),letterSpacing:cloneValue(v.letterSpacing)}));
  state.effectStyles=(await figma.getLocalEffectStylesAsync()).map(v=>({id:v.id,name:v.name,effects:cloneValue(v.effects)}));
 }
 if(enforceLimit&&canonical(state).length>SNAPSHOT_LIMIT)throw Error('Snapshot exceeds 24 MiB; split the operation before writing');
 return state;
}
async function restoreState(before,command){
 const errors=[];const attempt=async(label,fn)=>{try{await fn();}catch(e){errors.push({step:label,error:e.message});}};
 const now=await captureState(command,false),ids=new Set(before.nodes.map(n=>n.id));
 // Restore original topology before removing created containers (e.g. variant sets).
 for(const s of before.nodes){const n=await figma.getNodeByIdAsync(s.id);if(!n){errors.push({step:s.id,error:'Original node was removed'});continue;}
  if(s.parentId)await attempt('parent:'+s.id,async()=>{const parent=await figma.getNodeByIdAsync(s.parentId);if(n.parent?.id!==s.parentId||parent.children.indexOf(n)!==s.index)parent.insertChild(Math.min(s.index,parent.children.length),n);});
 }
 for(const s of [...now.nodes].reverse())if(!ids.has(s.id))await attempt('remove:'+s.id,async()=>{const n=await figma.getNodeByIdAsync(s.id);if(n&&!n.removed)n.remove();});
 for(const s of before.nodes)await attempt('restore:'+s.id,async()=>{
  const n=await figma.getNodeByIdAsync(s.id),p=s.props;
  if(n.type==='TEXT'){
   const fonts=s.segments?.map(x=>x.fontName)||[];if(p.fontName)fonts.push(p.fontName);
   for(const f of new Map(fonts.map(f=>[JSON.stringify(f),f])).values())await figma.loadFontAsync(f);
  }
  // Restore only changed properties: untouched instance/layout properties may be read-only.
  for(const key of snapshotFields){if(['width','height','relativeTransform','boundVariables','textStyleId','effectStyleId'].includes(key)||p[key]===undefined)continue;
   if(canonical(n[key])!==canonical(p[key]))n[key]=cloneValue(p[key]);}
  for(const [key,method] of [['textStyleId','setTextStyleIdAsync'],['effectStyleId','setEffectStyleIdAsync']])if(p[key]!==undefined&&n[key]!==p[key])await n[method](p[key]);
  if(p.boundVariables){const keys=new Set([...Object.keys(n.boundVariables||{}),...Object.keys(p.boundVariables)]);for(const key of keys){if(['fills','strokes','effects','layoutGrids','componentProperties'].includes(key))continue;const alias=p.boundVariables[key];n.setBoundVariable(key,alias?await figma.variables.getVariableByIdAsync(alias.id):null);}}
  if(n.type==='TEXT'&&s.segments&&canonical(n.getStyledTextSegments(segmentFields))!==canonical(s.segments))for(const seg of s.segments)for(const key of segmentFields){if(seg[key]===undefined||seg.end<=seg.start)continue;const suffix=key[0].toUpperCase()+key.slice(1),method=n['setRange'+suffix+'Async']||n['setRange'+suffix];if(method)await method.call(n,seg.start,seg.end,cloneValue(seg[key]));}
  if(p.width!==undefined&&p.height!==undefined&&(n.width!==p.width||n.height!==p.height))n.resize(p.width,p.height);
  if(p.relativeTransform&&canonical(n.relativeTransform)!==canonical(p.relativeTransform))n.relativeTransform=p.relativeTransform;
  if(n.setPluginData)n.setPluginData('bridge.logicalKey',s.logicalKey);
 });
 if(before.collections){
  for(const [field,getter] of [['variables',()=>figma.variables.getLocalVariablesAsync()],['textStyles',()=>figma.getLocalTextStylesAsync()],['effectStyles',()=>figma.getLocalEffectStylesAsync()],['collections',()=>figma.variables.getLocalVariableCollectionsAsync()]]){
   const old=new Map(before[field].map(v=>[v.id,v]));
   for(const v of await getter())await attempt(field+':'+v.id,async()=>{
    const value=old.get(v.id);if(!value){v.remove();return;}
    if(field==='collections'){v.name=value.name;for(const mode of value.modes)v.renameMode(mode.modeId,mode.name);return;}
    if(field==='variables'){v.name=value.name;v.scopes=value.scopes;for(const platform of ['WEB','ANDROID','iOS']){if(value.codeSyntax?.[platform])v.setVariableCodeSyntax(platform,value.codeSyntax[platform]);else if(v.codeSyntax?.[platform])v.removeVariableCodeSyntax(platform);}for(const [id,val] of Object.entries(value.valuesByMode))v.setValueForMode(id,val);return;}
    if(value.fontName)await figma.loadFontAsync(value.fontName);for(const [key,val] of Object.entries(value))if(key!=='id')v[key]=cloneValue(val);
   });
  }
 }
 const residual=stateDiff(before,await captureState(command,false));if(residual.length)errors.push({step:'verify-restoration',error:'State differs from the saved snapshot',nodes:residual.map(d=>d.id)});
 return {ok:!errors.length,errors};
}
function stateDiff(before,after){
 const changes=[];
 for(const field of ['nodes','collections','variables','textStyles','effectStyles']){
  const old=new Map((before[field]||[]).map(n=>[n.id,n])),next=new Map((after[field]||[]).map(n=>[n.id,n]));
  for(const id of new Set([...old.keys(),...next.keys()])){const a=old.get(id),b=next.get(id);if(canonical(a)===canonical(b))continue;
   const properties=[];for(const key of new Set([...Object.keys(a?.props||a||{}),...Object.keys(b?.props||b||{})])){const x=(a?.props||a)?.[key],y=(b?.props||b)?.[key];if(canonical(x)!==canonical(y))properties.push({property:key,before:x??null,after:y??null});}
   if(a&&b&&a.index!==b.index)properties.push({property:'index',before:a.index,after:b.index});
   if(a&&b&&a.parentId!==b.parentId)properties.push({property:'parentId',before:a.parentId,after:b.parentId});
   if(a&&b&&canonical(a.segments)!==canonical(b.segments))properties.push({property:'textSegments',before:a.segments,after:b.segments});
   changes.push({id,kind:field,path:b?.path||a?.path||b?.name||a?.name,action:!a?'create':!b?'remove':'update',properties});
  }
 }
 return changes;
}
const readCommands=new Set(['ping','bridge-capabilities','get-document-info','get-pages','get-node','get-fonts','export-node','validate-layout','review-layout','operation-history']);
function nonUndoable(c){return c.type==='import-image'?'Image bytes cannot be removed from the Figma image store':c.type==='design-system'&&['property','variants'].includes(c.action)?'Component property definitions and variant metadata cannot be restored reliably':null;}
function resolveReferences(value,steps){
 if(Array.isArray(value))return value.map(v=>resolveReferences(v,steps));
 if(value&&typeof value==='object'){if(Object.keys(value).length===1&&value.$ref){const parts=value.$ref.split('.');const first=parts.shift();let result=Object.hasOwn(steps,first)?steps[first]:undefined;for(const p of parts)result=result&&Object.hasOwn(result,p)?result[p]:undefined;if(result===undefined)throw Error('Unresolved step reference: '+value.$ref);return result;}return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolveReferences(v,steps)]));}return value;
}
async function planCommand(c){
 await commandPage(c);const reason=nonUndoable(c);
 const writes=['build-section','update-node','import-image','design-system','batch','repair-layout',...highLevelTypes];if(!writes.includes(c.type))throw Error('Unsupported write command: '+c.type);
 if(c.type==='design-system'&&!['inspect','page','collection','variable','text-style','effect-style','bind','variants','property','describe','clone-component','replace-instance'].includes(c.action))throw Error('Unsupported design-system action: '+c.action);
 if(c.type==='repair-layout')return planVisualRepair(c);
 if(c.type==='build-section'){
  if(!Array.isArray(c.nodes))throw Error('nodes array required');const nodes=[];
  async function walk(spec,path){if(!['FRAME','COMPONENT','RECTANGLE','ELLIPSE','TEXT','SVG','INSTANCE'].includes(spec.kind))throw Error('Unsupported kind: '+spec.kind);if(spec.kind==='TEXT'&&!spec.fontName)throw Error('Text fontName required');if(spec.kind==='INSTANCE'){const component=await figma.getNodeByIdAsync(spec.componentId);if(component?.type!=='COMPONENT')throw Error('Missing component');}nodes.push({path,type:spec.kind,properties:Object.entries(spec).filter(([k])=>!['children','kind'].includes(k)).map(([property,after])=>({property,before:null,after}))});for(const [i,child] of (spec.children||[]).entries())await walk(child,path+'/'+(child.name||i));}
  for(const [i,spec] of c.nodes.entries())await walk(spec,(spec.name||String(i)));return {parentId:c.parentId||c.target?.pageId,nodes,rollback:'supported'};
 }
 if(c.type==='batch'){
  if(!Array.isArray(c.commands)||!c.commands.length||c.commands.length>100)throw Error('batch requires 1–100 commands');
  const steps=[],seen=new Set();
  for(const [i,step] of c.commands.entries()){
   const stepId=step?.stepId||String(i);
   try{
    if(!step||typeof step!=='object'||Array.isArray(step))throw Error('Batch step must be an object');
    if(seen.has(stepId))throw Error('Duplicate stepId');seen.add(stepId);
    if(step.type==='batch'||step.type==='undo-operation'||readCommands.has(step.type)||step.target)throw Error('Batch steps must be individual writes without routing');
    if(nonUndoable(step))throw Error('Atomic batch cannot include non-undoable step');
    const symbolic=JSON.stringify(step).includes('"$ref"'),plan=symbolic?{fields:Object.keys(step.props||step),references:'resolved when preceding steps complete'}:await planCommand({...step,target:c.target});
    steps.push({step:stepId,type:step.type,plan,rollback:'supported'});
   }catch(error){throw Object.assign(Error('Preflight step '+stepId+': '+error.message),{details:{failedStep:stepId,phase:'preflight',rollback:{ok:true,notNeeded:true}}});}
  }
  return {steps,rollback:'supported'};
 }
 if(c.type==='update-node'){
  const n=await figma.getNodeByIdAsync(c.nodeId);if(!n)throw Error('Node not found');if(!c.props||typeof c.props!=='object')throw Error('props object required');validateTextAlignment(n,c.props);
  if(n.type==='TEXT'&&n.hasMissingFont)throw Error('Text has missing fonts; choose an available font before editing');
  const allowed=['x','y','name','fills','strokes','opacity','fontSize','characters','textAlignHorizontal','textAlignVertical','lineHeight','letterSpacing','visible','clipsContent','width','height'];
  for(const key of Object.keys(c.props))if(!allowed.includes(key))throw Error('Unsupported update property: '+key);
  if((c.props.width===undefined)!==(c.props.height===undefined))throw Error('width and height must be supplied together');
  return {nodes:[{id:n.id,path:nodePath(n),properties:Object.entries(c.props).map(([property,after])=>({property,before:cloneValue(n[property]),after}))}],rollback:'supported'};
 }
 if(isHighLevel(c.type)&&!['create-variable-collection','apply-auto-layout'].includes(c.type)){
  if(typeof c.key!=='string'||!c.key.trim()||c.key.length>120)throw Error('Stable key (1–120 characters) is required');
  const spec=templateFor(c),nodes=[],parent=c.parentId?await figma.getNodeByIdAsync(c.parentId):await commandPage(c);
  if(!parent||!('appendChild' in parent))throw Error('Parent cannot contain nodes');
  const variables=c.tokenCollectionId?new Map((await figma.variables.getLocalVariablesAsync()).filter(v=>v.variableCollectionId===c.tokenCollectionId).map(v=>[v.name,v])):new Map();
  function visit(s,key,p){const matches=p?.children?.filter(n=>n.getPluginData('bridge.logicalKey')===key)||[];if(matches.length>1)throw Error('Duplicate logical key: '+key);const n=matches[0];if(n&&n.type!==s.kind)throw Error('Logical key changed node type: '+key);
   const properties=Object.entries(s).filter(([k])=>!['children','key','kind','fillToken'].includes(k)).map(([property,value])=>{let after=value;if(property==='fills'&&s.fillToken&&variables.has(s.fillToken))after=value.map(p=>figma.variables.setBoundVariableForPaint(p,'color',variables.get(s.fillToken)));return {property,before:cloneValue(n?.[property])??null,after};}).filter(v=>canonical(v.before)!==canonical(v.after));
   nodes.push({id:n?.id||null,path:n?nodePath(n):key,logicalKey:key,type:s.kind,name:s.name,action:n?'update':'create',properties});
   for(const child of s.children||[])visit(child,key+'/'+child.key,n);
  }visit(spec,c.key,parent);return {type:c.type,nodes,rollback:'supported'};
 }
 return {type:c.type,action:c.action||null,parentId:c.parentId||c.target?.pageId,fields:Object.keys(c),rollback:reason?'unsupported':'supported',warning:reason,semantics:c.action==='replace-instance'?'Creates an instance; hides and renames the original as 原始备份. Undo restores the original.':undefined};
}
async function executeReliable(command,progress,requestId){
 if(command.type==='operation-history')return [...operationHistory.values()].filter(o=>command.target?.scope==='file'||o.target.pageId===(command.target?.pageId||figma.currentPage.id)).map(({before,after,...o})=>o);
 if(command.type==='review-layout')return createVisualReview(command,requestId);
 if(command.type==='validate-layout')return validateLayout(command);
 if(command.type==='undo-operation'){
  await commandPage(command);const op=operationHistory.get(command.operationId);if(!op||op.undone)throw Error('Undo snapshot unavailable or already used; history lasts only for this plugin session');
  if(!command.target||command.target.scope!=='file'&&(op.target.scope==='file'||command.target.pageId!==op.target.pageId))throw Error('Undo target is outside the bound scope');
  const originalCommand={...command,target:op.target};
  if(canonical(await captureState(originalCommand,false))!==canonical(op.after))throw Error('Undo conflict: design changed after this operation; inspect the diff instead of overwriting later edits');
  if(command.dryRun)return {dryRun:true,operationId:op.operationId,diff:stateDiff(op.after,op.before)};
  progress('undoing');const restored=await restoreState(op.before,originalCommand);if(!restored.ok)throw Object.assign(Error('Undo incomplete'),{details:restored});op.undone=true;
  return {operationId:op.operationId,undone:true,diff:stateDiff(op.after,op.before)};
 }
 if(readCommands.has(command.type)||command.type==='design-system'&&command.action==='inspect')return executeLegacy(command,progress);
 const plan=await planCommand(command);
 if(command.dryRun)return {dryRun:true,plan,writes:0};
 const unsupported=nonUndoable(command);if(unsupported&&!command.allowNonUndoable)throw Error('Cannot reliably undo: '+unsupported+'. Inspect dry-run, then set allowNonUndoable:true explicitly if intended.');
 if(unsupported)return {...await executeLegacy(command,progress),undo:{supported:false,reason:unsupported}};
 const before=await captureState(command),steps=Object.create(null),completedSteps=[];let currentStep=null;
 try{
  progress('snapshot-saved',{nodes:before.nodes.length});let result;
  if(command.type==='batch'){
   for(const [i,raw] of command.commands.entries()){currentStep=raw.stepId||String(i);if(Object.hasOwn(steps,currentStep))throw Error('Duplicate stepId');const step={...resolveReferences(raw,steps),target:command.target};await planCommand(step);steps[currentStep]=await executeWrite(step,progress);completedSteps.push({step:currentStep,type:step.type,result:steps[currentStep]});}result={steps:completedSteps};
  }else result=await executeWrite({...command,nextReviewId:requestId+'-review'},progress);
  const after=await captureState(command),diff=stateDiff(before,after);
  const operationId=requestId;operationHistory.set(operationId,{operationId,target:command.target,type:command.type,createdAt:new Date().toISOString(),before,after,undone:false});
  let retained=0;for(const [id,op] of [...operationHistory].reverse()){retained+=canonical(op.before).length+canonical(op.after).length;if(retained>SNAPSHOT_LIMIT*2||operationHistory.size>20)operationHistory.delete(id);}
  figma.commitUndo?.();return {...result,operationId,diff,undo:{supported:true,sessionOnly:true},plan};
 }catch(error){progress('rolling-back');let rollback;try{rollback=await restoreState(before,command);}catch(restoreError){rollback={ok:false,errors:[{step:'restore',error:restoreError.message}]};}throw Object.assign(Error(error.message),{details:{failedStep:currentStep,completedSteps:completedSteps.map(s=>({step:s.step,type:s.type})),rollback}});}
}
async function executeWrite(c,progress){if(c.type==='repair-layout')return executeVisualRepair(c);return isHighLevel(c.type)?executeHighLevel(c,progress):executeLegacy(c,progress);}
