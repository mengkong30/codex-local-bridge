function rectangle(n){return n.absoluteBoundingBox||{x:n.x||0,y:n.y||0,width:n.width||0,height:n.height||0};}
function overlap(a,b){return Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));}
function luminance(c){const f=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b);}
function composite(a,b,alpha){return {r:a.r*alpha+b.r*(1-alpha),g:a.g*alpha+b.g*(1-alpha),b:a.b*alpha+b.b*(1-alpha)};}
function backgroundFor(n){
 const chain=[];let branch=n;for(let p=n.parent;p&&p.type!=='DOCUMENT';p=p.parent){chain.unshift({parent:p,child:branch});branch=p;}
 let color={r:1,g:1,b:1},certain=true;const bounds=rectangle(n);
 function apply(node){if(node.opacity!==undefined&&node.opacity!==1)certain=false;const paints=Array.isArray(node.fills)?node.fills:[];for(const fill of paints.filter(f=>f.visible!==false)){if(fill.type==='SOLID')color=composite(fill.color,color,(fill.opacity??1)*(node.opacity??1));else certain=false;}}
 for(const {parent,child} of chain){apply(parent);const index=parent.children?.indexOf(child)??0;
  for(const sibling of parent.children?.slice(0,index)||[]){if(sibling.visible===false||!['RECTANGLE','FRAME','COMPONENT','INSTANCE'].includes(sibling.type))continue;const box=rectangle(sibling);
   if(box.x<=bounds.x+.5&&box.y<=bounds.y+.5&&box.x+box.width>=bounds.x+bounds.width-.5&&box.y+box.height>=bounds.y+bounds.height-.5){apply(sibling);if(sibling.rotation||sibling.children?.length)certain=false;}
  }
 }return {color,certain};
}
function estimatedText(n){
 const segments=n.getStyledTextSegments(['fontSize','lineHeight','letterSpacing','fontName']),lines=[0];let maxHeight=0;
 for(const segment of segments){const size=Number(segment.fontSize)||12,lh=segment.lineHeight,spacing=segment.letterSpacing;maxHeight=Math.max(maxHeight,lh?.unit==='PIXELS'?lh.value:lh?.unit==='PERCENT'?size*lh.value/100:size*1.2);
  for(const ch of segment.characters){if(ch==='\n'){lines.push(0);continue;}lines[lines.length-1]+=(/[\u2e80-\uffff]/.test(ch)?1:/[il.,:!' ]/.test(ch)?.3:/[MW@]/.test(ch)?.9:.56)*size+(spacing?.unit==='PIXELS'?spacing.value:spacing?.value?size*spacing.value/100:0);}}
 const width=Math.max(0,...lines),lineCount=lines.reduce((sum,w)=>sum+Math.max(1,Math.ceil(w/Math.max(n.width,1))),0);return {width,height:lineCount*maxHeight,lineHeight:maxHeight,method:'font-size heuristic; confirm in screenshot'};
}
async function validateLayout(c){
 const page=await commandPage(c),root=c.nodeId?await figma.getNodeByIdAsync(c.nodeId):page;if(!root)throw Error('Validation root missing');
 const maxNodes=c.maxNodes??5000;if(!Number.isInteger(maxNodes)||maxNodes<1||maxNodes>20000)throw Error('maxNodes must be 1–20000');
 const issues=[],notes=[],nodes=[],screenshots=[];let truncated=false;
 function visit(n){if(n.visible===false&&!c.includeHidden)return;if(nodes.length>=maxNodes){truncated=true;return;}nodes.push(n);for(const child of n.children||[])visit(child);}visit(root);
 const add=(n,code,severity,message,suggestion,details={},confidence='high')=>issues.push({nodeId:n.id,path:nodePath(n),code,severity,message,suggestion,confidence,bounds:rectangle(n),...details});
 const tolerance=Number.isFinite(c.tolerance)?Math.max(0,c.tolerance):1;
 for(const n of nodes){
  const b=rectangle(n),p=n.parent;
  if(p&&['FRAME','COMPONENT','INSTANCE','COMPONENT_SET'].includes(p.type)){
   // Compare corners in the parent's local coordinates, including rotated children.
   const t=n.relativeTransform||[[1,0,n.x],[0,1,n.y]],corners=[[0,0],[n.width,0],[0,n.height],[n.width,n.height]].map(([x,y])=>({x:t[0][0]*x+t[0][1]*y+t[0][2],y:t[1][0]*x+t[1][1]*y+t[1][2]}));
   if(corners.some(v=>v.x < -tolerance||v.y < -tolerance||v.x>p.width+tolerance||v.y>p.height+tolerance))add(n,'OUTSIDE_PARENT',p.clipsContent?'error':'warning','Node extends beyond its parent','Move/resize the node or deliberately expand the parent',{parentId:p.id,clipped:!!p.clipsContent});
  }
  if(n.type==='TEXT'){
   if(!n.characters.trim())add(n,'EMPTY_TEXT','info','Empty text layer','Remove it or populate its content');
   else {
    const e=estimatedText(n);if(n.hasMissingFont)add(n,'MISSING_FONT','error','One or more fonts are missing','Install the specified font or explicitly choose an available replacement');
    if(c.expectedFonts){const actual=n.getStyledTextSegments(['fontName']).map(s=>s.fontName.family);if(actual.some(f=>!c.expectedFonts.includes(f)))add(n,'UNEXPECTED_FONT','warning','Text uses a font outside the expected family list','Check whether font substitution occurred',{actualFamilies:[...new Set(actual)]});}
    if(n.height>Math.max(e.lineHeight*4,e.height*3)||n.textAutoResize==='WIDTH_AND_HEIGHT'&&n.width>Math.max(600,e.width*8))add(n,'ABNORMAL_TEXT_BOX','warning','Text box is unusually large relative to its content','Check SVG import sizing; fit the text box to the intended label',{estimated:e},'heuristic');
    if(['NONE','TRUNCATE'].includes(n.textAutoResize)&&e.height>n.height+tolerance||n.textTruncation==='ENDING'&&n.maxLines&&e.height>n.maxLines*e.lineHeight+tolerance)add(n,'TEXT_CLIPPING','warning','Text may exceed the fixed text box','Increase height/width or use text auto resize; confirm in screenshot',{estimated:e},'heuristic');
    const bg=backgroundFor(n),fills=Array.isArray(n.fills)?n.fills:[];
    const segments=n.getStyledTextSegments(['fills','fontSize','fontName']);let minimum=Infinity,threshold=4.5;
    for(const seg of segments){const paint=seg.fills?.find(p=>p.type==='SOLID'&&p.visible!==false);if(!paint||!bg.certain)continue;const color=composite(paint.color,bg.color,(paint.opacity??1)*(n.opacity??1)),a=luminance(color),b=luminance(bg.color),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05),large=seg.fontSize>=24||seg.fontSize>=18.66&&/bold/i.test(seg.fontName?.style||'');const required=large?3:4.5;if(ratio<required&&ratio<minimum){minimum=ratio;threshold=required;}}
    if(minimum<Infinity)add(n,'LOW_CONTRAST','warning','Text contrast is below the reference threshold','Adjust text or background colors',{ratio:Math.round(minimum*100)/100,required:threshold},'estimated-solid-background');
    if(!bg.certain||!fills.some(p=>p.type==='SOLID'))notes.push({nodeId:n.id,check:'contrast',reason:'Complex fill, transparency or background; inspect screenshot'});
   }
  }
  if(['FRAME','GROUP','COMPONENT'].includes(n.type)&&!n.children?.length&&(!Array.isArray(n.fills)||!n.fills.some(p=>p.visible!==false))&&!n.strokes?.length)add(n,'EMPTY_LAYER','info','Empty container without visible content','Remove if unused');
  if(p?.type==='PAGE'&&!['FRAME','SECTION','COMPONENT','COMPONENT_SET'].includes(n.type))add(n,'ORPHAN_CANDIDATE','info','Loose top-level node outside a frame','Place it in its intended frame or mark it as an intentional canvas item',{},'heuristic');
 }
 const canvas=c.canvasId?await figma.getNodeByIdAsync(c.canvasId):root.type==='PAGE'?null:root;
 if(c.canvasId){await commandPage({...c,nodeId:c.canvasId});if(!canvas)throw Error('Canvas missing');const bounds=rectangle(canvas);let canvasPage=canvas;while(canvasPage&&canvasPage.type!=='PAGE')canvasPage=canvasPage.parent;for(const n of canvasPage?.children||[]){if(n.id===canvas.id||n.visible===false)continue;if(['FRAME','COMPONENT','COMPONENT_SET','SECTION','INSTANCE'].includes(n.type)){notes.push({nodeId:n.id,check:'outside-canvas',reason:'Peer canvas/component is preserved as an independent top-level design'});continue;}if(overlap(rectangle(n),bounds)===0)add(n,'OUTSIDE_CANVAS','warning','Top-level node lies outside the target canvas','Move it into the intended canvas or exclude intentional reference assets',{canvasId:canvas.id},'heuristic');}}
 // Label-only sweep avoids decorative chart shapes being mistaken for collisions.
 const labels=nodes.filter(n=>n.type==='TEXT'&&n.characters.trim()).map(n=>({n,b:rectangle(n)})).sort((a,b)=>a.b.x-b.b.x);let pairs=0;
 for(let i=0;i<labels.length&&pairs<200000;i++)for(let j=i+1;j<labels.length&&labels[j].b.x<labels[i].b.x+labels[i].b.width;j++){
  if(++pairs>200000){notes.push({check:'label-overlap',reason:'Pair budget reached'});break;}
  const a=labels[i],b=labels[j];if(a.n.parent?.id!==b.n.parent?.id)continue;const area=overlap(a.b,b.b);if(area>tolerance*tolerance)add(b.n,'LABEL_OVERLAP','warning','Sibling text labels overlap','Increase spacing, shorten labels or reduce label frequency',{relatedNodeId:a.n.id,overlapArea:area},'bounding-box');
 }
 const exports=c.nodeId?[root]:page.children.filter(n=>['FRAME','COMPONENT'].includes(n.type)).slice(0,4);
 if(c.screenshots!==false)for(const n of exports){if(!n.exportAsync)continue;const scale=Math.min(1,2048/Math.max(n.width,n.height));const bytes=await n.exportAsync({format:'PNG',constraint:{type:'SCALE',value:scale}});if(bytes.length<24||bytes[0]!==137||bytes[1]!==80)throw Error('Invalid PNG export');const u32=i=>bytes[i]*16777216+bytes[i+1]*65536+bytes[i+2]*256+bytes[i+3];const width=u32(16),height=u32(20);const expected=c.expectedSize||{width:n.width,height:n.height};
  if(Math.abs(width-expected.width*scale)>1||Math.abs(height-expected.height*scale)>1)add(n,'EXPORT_SIZE_MISMATCH','error','PNG dimensions differ from the target canvas','Inspect frame dimensions, export scale and crop settings',{expected,actual:{width,height},scale});
  screenshots.push({nodeId:n.id,path:nodePath(n),format:'PNG',width,height,scale,base64:figma.base64Encode(bytes)});
 }
 return {rootId:root.id,checkedNodes:nodes.length,truncated,issues,summary:{errors:issues.filter(i=>i.severity==='error').length,warnings:issues.filter(i=>i.severity==='warning').length,info:issues.filter(i=>i.severity==='info').length},screenshots,notes,limitations:['Text fit and fallback detection are heuristic; Figma does not expose glyph overflow or silent font substitution directly.','Contrast checks cover solid paints with known backgrounds; complex fills require screenshot review.'],visualReview:{required:issues.length>0||notes.length>0,next:'Review screenshots, apply targeted fixes, then validate the same root again.'}};
}
