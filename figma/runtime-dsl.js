const highLevelTypes=new Set(['create-panel','create-kpi-card','create-line-chart','create-donut-chart','create-digital-twin-map','create-component','create-variable-collection','apply-auto-layout']);
const isHighLevel=type=>highLevelTypes.has(type);
const defaultTokens={colors:{surface:'#ffffff',surfaceAlt:'#f4f7fb',text:'#202c3a',muted:'#657487',border:'#dfe6ef',accent:'#377bda',positive:'#21865e',chart2:'#36a8a0',chart3:'#e9aa49'},spacing:{small:8,medium:16,large:24},typography:{fontFamily:'Inter',fontStyle:'Regular',label:12,value:30,title:16}};
function tokensFor(c){return Object.fromEntries(Object.entries(defaultTokens).map(([k,v])=>[k,{...v,...c.tokens?.[k]}]));}
function colorFrom(value){if(typeof value==='object'&&value&&['r','g','b'].every(k=>Number.isFinite(value[k])))return value;const hex=String(value).replace('#','');if(!/^[\da-f]{6}$/i.test(hex))throw Error('Color requires #rrggbb or RGB object');return {r:parseInt(hex.slice(0,2),16)/255,g:parseInt(hex.slice(2,4),16)/255,b:parseInt(hex.slice(4,6),16)/255};}
const paint=color=>[{type:'SOLID',color:colorFrom(color)}];
function templateFor(c){
 const t=tokensFor(c),w=c.width??360,h=c.height??220,font={family:t.typography.fontFamily,style:t.typography.fontStyle},sp=t.spacing;
 if(!(w>0&&h>0&&Number.isFinite(w)&&Number.isFinite(h)))throw Error('Positive finite dimensions required');
 const text=(key,name,characters,x,y,width,size=t.typography.label,token='text')=>({key,kind:'TEXT',name,characters:String(characters),fontName:font,fontSize:size,textAutoResize:'HEIGHT',x,y,width,height:size*1.5,fills:paint(t.colors[token]),fillToken:'colors/'+token});
 const shape=(key,name,x,y,width,height,token='surfaceAlt')=>({key,kind:'RECTANGLE',name,x,y,width,height,fills:paint(t.colors[token]),fillToken:'colors/'+token});
 const frame={key:c.key,kind:c.type==='create-component'?'COMPONENT':'FRAME',name:c.name||c.title||c.key,x:c.x??0,y:c.y??0,width:w,height:h,fills:paint(t.colors.surface),fillToken:'colors/surface',cornerRadius:c.cornerRadius??8,clipsContent:true,children:[]};
 const add=(...specs)=>frame.children.push(...specs);
 if(c.type==='create-kpi-card'){
  frame.height=c.height??132;add(text('label','指标名称',c.label||c.title||'指标',sp.medium,sp.medium,w-2*sp.medium,t.typography.label,'muted'),text('value','指标值',c.value??'—',sp.medium,42,w-2*sp.medium,t.typography.value),text('detail','指标说明',[c.unit,c.detail].filter(Boolean).join(' · '),sp.medium,frame.height-32,w-2*sp.medium,t.typography.label,'muted'));
 }else if(c.type==='create-panel'||c.type==='create-component'){
  if(c.title)add(text('title','面板标题',c.title,sp.medium,sp.medium,w-2*sp.medium,t.typography.title));
  for(const [i,item] of (c.items||[]).entries()){if(!isHighLevel(item.type)||['apply-auto-layout','create-variable-collection'].includes(item.type))throw Error('Panel items must be visual high-level commands');if(!item.key)throw Error('Each panel item requires a stable key');frame.children.push(templateFor({...item,tokens:c.tokens,...item.tokens?{tokens:{...c.tokens,...item.tokens}}:{},key:item.key}));}
  for(const spec of c.children||[]){if(!spec.key)throw Error('Component child specs require stable keys');frame.children.push(spec);}
 }else if(c.type==='create-line-chart'){
  const labels=c.labels||[],series=c.series||[];if(!labels.length||!series.length||labels.length>500||series.length>20)throw Error('Line chart needs 1–500 labels and 1–20 series');
  if(series.some(s=>s.values?.length!==labels.length||s.values.some(v=>!Number.isFinite(v))))throw Error('Each series must have one finite value per label');
  const left=48,right=w-20,top=48,bottom=h-36;if(right<=left||bottom<=top)throw Error('Chart dimensions too small');
  const vals=series.flatMap(s=>s.values),min=c.min??Math.min(0,...vals),max=c.max??Math.max(...vals,1);if(max<=min)throw Error('Chart max must exceed min');
  add(text('title','图表标题',c.title||'趋势',16,12,w-32,t.typography.title));
  for(let i=0;i<=4;i++){const y=top+(bottom-top)*i/4;add(shape('grid-'+i,'网格线',left,y,right-left,1,'border'),text('y-'+i,'纵轴刻度',Math.round((max-(max-min)*i/4)*100)/100,4,y-8,left-8,10,'muted'));}
  const stride=Math.max(1,Math.ceil(labels.length/Math.max(1,Math.floor((right-left)/76))));
  labels.forEach((label,i)=>{if(i%stride!==0)return;const x=left+(right-left)*i/Math.max(1,labels.length-1);add(text('label-'+i,'日期 / '+label,label,Math.min(x-28,w-60),bottom+10,56,10,'muted'));});
  series.forEach((s,i)=>{const path=s.values.map((v,j)=>(j?'L':'M')+(left+(right-left)*j/Math.max(1,labels.length-1)).toFixed(2)+' '+(bottom-(v-min)/(max-min)*(bottom-top)).toFixed(2)).join(' '),token=i===0?'accent':i%2?'chart2':'chart3';add({key:'series-'+(s.key||i),kind:'VECTOR',name:s.name||'系列 '+(i+1),x:0,y:0,width:w,height:h,fills:[],strokes:paint(s.color||t.colors[token]),strokeWeight:2,vectorPaths:[{windingRule:'NONZERO',data:path}]});});
 }else if(c.type==='create-donut-chart'){
  const slices=c.slices||[];if(!slices.length||slices.length>50||slices.some(s=>!Number.isFinite(s.value)||s.value<0)||slices.reduce((a,s)=>a+s.value,0)<=0)throw Error('Donut chart needs nonnegative slices with positive total');
  const cx=Math.min(w*.3,110),cy=(h+32)/2,r=Math.min(w*.22,(h-64)/2),inner=r*(c.innerRatio??.64);if(r<=0||inner<0||inner>=r)throw Error('Invalid donut geometry');
  add(text('title','图表标题',c.title||'占比',16,12,w-32,t.typography.title));let angle=-Math.PI/2;const total=slices.reduce((a,s)=>a+s.value,0),point=(rad,a)=>[cx+rad*Math.cos(a),cy+rad*Math.sin(a)].map(v=>v.toFixed(3)).join(' ');
  slices.forEach((s,i)=>{if(!s.value)return;const end=angle+s.value/total*Math.PI*2,mid=(angle+end)/2,token=i%3===0?'accent':i%3===1?'chart2':'chart3',large=end-angle>Math.PI?1:0;
   // Cubic segments (at most 90 degrees each) use the supported Figma vector path subset.
   const arc=(rad,start,finish)=>{const count=Math.ceil(Math.abs(finish-start)/(Math.PI/2)),delta=(finish-start)/count,parts=[];for(let j=0;j<count;j++){const a=start+j*delta,b=a+delta,k=4/3*Math.tan(delta/4);const coords=[cx+rad*(Math.cos(a)-k*Math.sin(a)),cy+rad*(Math.sin(a)+k*Math.cos(a)),cx+rad*(Math.cos(b)+k*Math.sin(b)),cy+rad*(Math.sin(b)-k*Math.cos(b)),cx+rad*Math.cos(b),cy+rad*Math.sin(b)];parts.push('C '+coords.map(v=>v.toFixed(3)).join(' '));}return parts.join(' ');};
   const path=`M ${point(r,angle)} ${arc(r,angle,end)} L ${point(inner,end)} ${arc(inner,end,angle)} Z`;
   add({key:'slice-'+(s.key||i),kind:'VECTOR',name:s.label||'分区 '+i,x:0,y:0,width:w,height:h,fills:paint(s.color||t.colors[token]),...!s.color?{fillToken:'colors/'+token}:{},vectorPaths:[{windingRule:'NONZERO',data:path}]});
   const legendX=cx+r+18,y=52+i*28;if(y+20>h)throw Error('Increase donut height to fit all legend rows');add(shape('swatch-'+i,'图例色块',legendX,y+4,8,8,token),text('legend-'+i,'图例 / '+s.label,`${s.label}: ${s.value}`,legendX+16,y,w-legendX-24,11,'muted'));angle=end;
  });
 }else if(c.type==='create-digital-twin-map'){
  add(text('title','地图标题',c.title||'园区地图',16,12,w-32,t.typography.title),shape('map-bg','地图背景',16,44,w-32,h-60));
  const points=c.buildings||[];if(points.length>300)throw Error('Map supports up to 300 editable buildings');
  points.forEach((b,i)=>{if(!b.key)throw Error('Each building requires a stable key');const area={x:16+(w-32)*(b.x??0),y:44+(h-60)*(b.y??0),width:(w-32)*(b.width??.1),height:(h-60)*(b.height??.12)};if(area.x<16||area.y<44||area.x+area.width>w-16||area.y+area.height>h-16)throw Error('Building lies outside normalized map bounds');
   const building=shape('building-'+b.key,b.name||b.key,area.x,area.y,area.width,area.height,b.status==='alert'?'chart3':'accent');building.cornerRadius=3;add(building,text('label-'+b.key,'地图标签 / '+(b.name||b.key),b.name||b.key,area.x,Math.min(area.y+area.height+3,h-32),Math.min(Math.max(area.width,72),w-16-area.x),10));});
  for(const [i,r] of (c.regions||[]).entries()){if(!r.key||!r.path)throw Error('Map regions require key and vector path');if(/[A-BD-KN-PR-Yac-z]/.test(r.path))throw Error('Region path supports absolute M/L/C/Q/Z only; convert SVG arcs first');add({key:'region-'+r.key,kind:'VECTOR',name:r.name||r.key,x:16,y:44,width:w-32,height:h-60,fills:paint(r.color||t.colors.chart2),opacity:.25,vectorPaths:[{windingRule:'NONZERO',data:r.path}]});}
 }
 return frame;
}
async function executeHighLevel(c,progress){
 const page=await commandPage(c);
 if(c.type==='create-variable-collection'){
  if(c.target?.scope!=='file')throw Error('Variable collection requires file binding');
  const t=tokensFor(c),collectionResult=await designSystemCommand({action:'collection',name:c.name||'Bridge design tokens',mode:c.mode||'默认'}),variables={};
  for(const [group,values] of Object.entries(t))for(const [key,value] of Object.entries(values)){
   const name=group+'/'+key,dataType=group==='colors'?'COLOR':typeof value==='number'?'FLOAT':'STRING';
   const result=await designSystemCommand({action:'variable',collectionId:collectionResult.id,name,dataType,value:dataType==='COLOR'?{...colorFrom(value),a:1}:value,scopes:['ALL_SCOPES'],codeSyntax:'--'+name.replaceAll('/','-')});variables[name]=result.id;
  }
  return {id:collectionResult.id,modeId:collectionResult.modeId,variables};
 }
 if(c.type==='apply-auto-layout'){
  const n=await figma.getNodeByIdAsync(c.nodeId);if(!n||!('layoutMode' in n))throw Error('Auto layout requires a frame/component');
  const props={layoutMode:c.direction||'VERTICAL',itemSpacing:c.gap??tokensFor(c).spacing.medium,paddingLeft:c.padding??16,paddingRight:c.padding??16,paddingTop:c.padding??16,paddingBottom:c.padding??16,primaryAxisSizingMode:c.primaryAxisSizingMode||'AUTO',counterAxisSizingMode:c.counterAxisSizingMode||'FIXED',primaryAxisAlignItems:c.primaryAxisAlignItems||'MIN',counterAxisAlignItems:c.counterAxisAlignItems||'MIN'};
  for(const [k,v] of Object.entries(props))n[k]=v;return {id:n.id,path:nodePath(n)};
 }
 if(typeof c.key!=='string'||!c.key.trim()||c.key.length>120)throw Error('Stable key (1–120 characters) is required');
 const parent=c.parentId?await figma.getNodeByIdAsync(c.parentId):page;if(!parent||!('appendChild' in parent))throw Error('Parent cannot contain nodes');
 const spec=templateFor(c),refs=[],variables=c.tokenCollectionId?new Map((await figma.variables.getLocalVariablesAsync()).filter(v=>v.variableCollectionId===c.tokenCollectionId).map(v=>[v.name,v])):new Map();
 if(c.tokenCollectionId&&!variables.size)throw Error('Token collection missing or empty');
 async function upsert(s,p,key){
  const matches=p.children.filter(n=>n.getPluginData('bridge.logicalKey')===key);if(matches.length>1)throw Error('Duplicate logical key: '+key);let n=matches[0];
  if(n&&n.type!==s.kind)throw Error('Logical key changed node type; choose a new key: '+key);
  if(s.kind==='TEXT')await figma.loadFontAsync(s.fontName||{family:'Inter',style:'Regular'});
  if(!n){const factories={FRAME:'createFrame',COMPONENT:'createComponent',RECTANGLE:'createRectangle',ELLIPSE:'createEllipse',TEXT:'createText',VECTOR:'createVector'};if(!factories[s.kind])throw Error('Unsupported template kind '+s.kind);n=figma[factories[s.kind]]();p.appendChild(n);if(s.kind==='VECTOR'&&s.strokes===undefined)n.strokes=[];n.setPluginData('bridge.logicalKey',key);}
  const props=['name','x','y','fills','strokes','strokeWeight','cornerRadius','clipsContent','opacity','fontName','fontSize','characters','textAlignHorizontal','textAlignVertical','textAutoResize','layoutMode','itemSpacing','paddingLeft','paddingRight','paddingTop','paddingBottom'];
  for(const prop of props)if(s[prop]!==undefined&&canonical(n[prop])!==canonical(s[prop]))n[prop]=cloneValue(s[prop]);
  if(s.width!==undefined&&s.height!==undefined&&(n.width!==s.width||n.height!==s.height))n.resize(s.width,s.height);
  if(s.vectorPaths&&canonical(n.vectorPaths)!==canonical(s.vectorPaths))n.vectorPaths=cloneValue(s.vectorPaths);
  if(s.fillToken&&variables.has(s.fillToken))n.fills=n.fills.map(p=>figma.variables.setBoundVariableForPaint(p,'color',variables.get(s.fillToken)));
  const childKeys=new Set();for(const child of s.children||[]){if(!child.key||childKeys.has(child.key))throw Error('Unique child key required');childKeys.add(child.key);await upsert(child,n,key+'/'+child.key);}
  // Never delete unrecognized user layers. Obsolete managed nodes are hidden, so undo preserves IDs.
  for(const child of n.children||[]){const k=child.getPluginData('bridge.logicalKey');if(k.startsWith(key+'/')&&!childKeys.has(k.slice(key.length+1))&&k.slice(key.length+1).indexOf('/')<0)child.visible=false;}
  n.visible=true;refs.push({key,id:n.id,path:nodePath(n),type:n.type});return n;
 }
 progress('building',{template:c.type});const root=await upsert(spec,parent,c.key);return {id:root.id,roots:[{id:root.id,name:root.name,width:root.width,height:root.height}],nodes:refs,logicalKey:c.key};
}
