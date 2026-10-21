function validateTextAlignment(node, props) {
  const allowed = {textAlignVertical:['TOP','CENTER','BOTTOM'], textAlignHorizontal:['LEFT','CENTER','RIGHT','JUSTIFIED']};
  for (const key of Object.keys(allowed)) {
    if (props[key] === undefined) continue;
    if (node.type !== 'TEXT') throw new Error(key + ' requires a TEXT node');
    if (!allowed[key].includes(props[key])) throw new Error('Invalid ' + key + ': ' + props[key]);
  }
}

figma.showUI(__html__, { visible: true, width: 500, height: 740, themeColors: true });

let bridgeSettings=null,settingsWindowOpen=false;
function documentInfo(page = figma.currentPage) {
  return {
    fileKey: figma.fileKey || null,
    editorType: figma.editorType,
    fileName: figma.root.name,
    bridgeVersion: 11,
    bridgePackageVersion: '0.8.2',
    connectionSettings:bridgeSettings,
    panelProtocol: 1,
    pages: figma.root.children.map(p => ({id:p.id, name:p.name})),
    pageId: page.id,
    pageName: page.name,
    viewingPageId: figma.currentPage.id,
    selection: (page.selection||[]).map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type
    }))
  };
}
let documentInfoTimer=null;
function scheduleDocumentInfo(){
 if(documentInfoTimer)return;
 const send=()=>{documentInfoTimer=null;figma.ui.postMessage({type:'figma-info',payload:documentInfo()});};
 if(typeof setTimeout==='function')documentInfoTimer=setTimeout(send,120);else send();
}
figma.on?.('selectionchange',scheduleDocumentInfo);
figma.on?.('currentpagechange',scheduleDocumentInfo);

// Validate every destination before mutation. Components used as references may
// live on library pages; nodes being changed must belong to the bound page.
async function commandPage(command) {
  if (!command.target) return figma.currentPage;
  const target = command.target;
  const page = await figma.getNodeByIdAsync(target.pageId);
  if (!page || page.type !== 'PAGE') throw Error('Bound page no longer exists; bind another page explicitly');
  if(typeof page.loadAsync==='function')await page.loadAsync();
  const fileActions = ['page','collection','variable','text-style','effect-style'];
  if (target.scope !== 'file') {
    if (fileApiCommand(command) || command.type === 'import-image' || command.type === 'design-system' && fileActions.includes(command.action)) throw Error('Document-wide operation requires an exclusive file binding');
    const ids = ['nodeId','parentId','childId','sourceId'].map(key => command[key]).filter(Boolean).concat(command.nodeIds || [],command.type==='slides-action'&&Array.isArray(command.grid)?command.grid.flat():[],command.type==='figjam-action'?[command.connectorStart?.endpointNodeId,command.connectorEnd?.endpointNodeId].filter(Boolean):[]);
    for (const id of ids) {
      let node = await figma.getNodeByIdAsync(id);
      if (!node) throw Error('Target node no longer exists: ' + id);
      while (node && node.type !== 'PAGE') node = node.parent;
      if (!node || node.id !== page.id) throw Error('Node is outside the bound page: ' + id);
    }
  }
  if (command.focus && figma.currentPage.id !== page.id) throw Error('Focus requires the bound page to be visible; run without focus for background work');
  return page;
}

let executing = false;

figma.ui.onmessage = async (message) => {
  if(message.type==='bridge-settings-size'){settingsWindowOpen=!!message.open;figma.ui.resize(message.open?500:message.mode==='hub'?500:400,message.open?740:message.mode==='hub'?740:148);return;}
  if(message.type==='bridge-save-settings'){
    const s=message.settings;if(!s||!['auto','manual'].includes(s.mode)||!/^[\w.-]{1,60}$/.test(s.profile)||!Number.isInteger(s.port)||s.port<37821||s.port>37828)return;
    try{await figma.clientStorage?.setAsync('bridge.connection-settings.v1',s);bridgeSettings=s;figma.ui.postMessage({type:'bridge-settings-saved'});}catch(error){figma.ui.postMessage({type:'bridge-settings-error',error:error.message});}return;
  }
  if (message.type === 'bridge-panel-mode') {
    if (!settingsWindowOpen&&['hub','compact'].includes(message.mode)) figma.ui.resize(message.mode === 'hub' ? 500 : 400, message.mode === 'hub' ? 740 : 148);
    return;
  }
  if (message.type === "bridge-ready") {
    try {
      figma.ui.postMessage({ type: "figma-info", payload: await (async()=>{if(!bridgeSettings){try{bridgeSettings=await figma.clientStorage?.getAsync('bridge.connection-settings.v1')||null;}catch{bridgeSettings=null;}}return documentInfo();})() });
    } catch (error) {
      figma.ui.postMessage({type:'bridge-init-error', error:error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (message.type !== "bridge-command") return;

  if (executing) {
    figma.ui.postMessage({type:'bridge-result', requestId:message.requestId, ok:false, error:'Another command is still executing in this file'});
    return;
  }
  executing = true;

  const { requestId, command } = message;
  const startedAt = Date.now();
  const progress = (stage, details = {}) => figma.ui.postMessage({type:"bridge-progress",requestId,stage,elapsedMs:Date.now()-startedAt,...details});
  progress("started", {commandType:command.type});
  try {
    const result = await executeReliable(command, progress, requestId);
    progress("completed");
    figma.ui.postMessage({ type: "bridge-result", requestId, ok: true, result });
  } catch (error) {
    figma.ui.postMessage({
      type: "bridge-result",
      requestId,
      ok: false,
      error: commandError(error,command).message,
      details:error.details || null
    });
  } finally {
    executing = false;
  }
};

// Structured design-system operations; runs in the local Figma plugin sandbox.
async function designSystemCommand(c) {
  const get = async id => {const n=await figma.getNodeByIdAsync(id);if(!n)throw Error('Node not found: '+id);return n;};
  if(c.action==='inspect')return {
    collections:(await figma.variables.getLocalVariableCollectionsAsync()).map(v=>({id:v.id,name:v.name,modes:v.modes})),
    variables:(await figma.variables.getLocalVariablesAsync()).map(v=>({id:v.id,name:v.name,collectionId:v.variableCollectionId,valuesByMode:v.valuesByMode,scopes:v.scopes})),
    textStyles:(await figma.getLocalTextStylesAsync()).map(s=>({id:s.id,name:s.name})),
    effectStyles:(await figma.getLocalEffectStylesAsync()).map(s=>({id:s.id,name:s.name}))
  };
  if(c.action==='page') {let p=figma.root.children.find(p=>p.name===c.name);if(!p){p=figma.createPage();p.name=c.name;}return {id:p.id,name:p.name};}
  if(c.action==='collection') {let v=(await figma.variables.getLocalVariableCollectionsAsync()).find(v=>v.name===c.name);if(!v)v=figma.variables.createVariableCollection(c.name);v.renameMode(v.defaultModeId,c.mode||'默认');return {id:v.id,modeId:v.defaultModeId};}
  if(c.action==='variable') {
    const collection=await figma.variables.getVariableCollectionByIdAsync(c.collectionId);if(!collection)throw Error('Collection missing');
    let v=(await figma.variables.getLocalVariablesAsync()).find(v=>(v.name===c.name||v.name===c.previousName)&&v.variableCollectionId===collection.id);
    if(!v)v=figma.variables.createVariable(c.name,collection,c.dataType);
    v.name=c.name;v.scopes=c.scopes;v.setVariableCodeSyntax('WEB',c.codeSyntax);v.setValueForMode(collection.defaultModeId,c.value);return {id:v.id,name:v.name};
  }
  if(c.action==='text-style') {
    await figma.loadFontAsync(c.fontName);let s=(await figma.getLocalTextStylesAsync()).find(s=>s.name===c.name);if(!s)s=figma.createTextStyle();
    s.name=c.name;s.fontName=c.fontName;s.fontSize=c.fontSize;s.lineHeight=c.lineHeight;s.letterSpacing=c.letterSpacing||{unit:'PIXELS',value:0};return {id:s.id,name:s.name};
  }
  if(c.action==='effect-style') {let s=(await figma.getLocalEffectStylesAsync()).find(s=>s.name===c.name);if(!s)s=figma.createEffectStyle();s.name=c.name;s.effects=c.effects;return {id:s.id,name:s.name};}
  if(c.action==='bind') {
    const n=await get(c.nodeId);
    if(c.textStyleId){await figma.loadFontAsync(n.fontName);await n.setTextStyleIdAsync(c.textStyleId);}
    if(c.effectStyleId)await n.setEffectStyleIdAsync(c.effectStyleId);
    for(const b of c.bindings||[]){const v=await figma.variables.getVariableByIdAsync(b.variableId);if(!v)throw Error('Variable missing');
      if(b.field==='fills'||b.field==='strokes'){const ps=n[b.field].map(p=>({...p}));ps[b.index||0]=figma.variables.setBoundVariableForPaint(ps[b.index||0],'color',v);n[b.field]=ps;}
      else n.setBoundVariable(b.field,v);
    }return {id:n.id};
  }
  if(c.action==='variants') {
    const parent=await get(c.parentId);const nodes=[];for(const id of c.nodeIds){const n=await get(id);if(n.type!=='COMPONENT')throw Error('Variant must be component');nodes.push(n);}
    const set=figma.combineAsVariants(nodes,parent);set.name=c.name;set.description=c.description||'';set.x=c.x||0;set.y=c.y||0;
    nodes.forEach((n,i)=>{n.x=24+(i%(c.columns||4))*(c.cellWidth||160);n.y=48+Math.floor(i/(c.columns||4))*(c.cellHeight||100);});
    set.resize(Math.min(nodes.length,c.columns||4)*(c.cellWidth||160)+48,Math.ceil(nodes.length/(c.columns||4))*(c.cellHeight||100)+64);return {id:set.id,variants:nodes.map(n=>({id:n.id,name:n.name}))};
  }
  if(c.action==='property') {const n=await get(c.nodeId);const id=n.addComponentProperty(c.name,c.propertyType,c.defaultValue,c.options);if(c.childId){const child=await get(c.childId);child.componentPropertyReferences={...child.componentPropertyReferences,[c.field]:id};}return {id};}
  if(c.action==='describe') {const n=await get(c.nodeId);n.description=c.description;return {id:n.id};}
  if(c.action==='clone-component') {
    const source=await get(c.sourceId),parent=await get(c.parentId);const component=figma.createComponent();parent.appendChild(component);component.name=c.name;component.resize(c.width||source.width,c.height||source.height);component.fills=[];component.x=c.x||0;component.y=c.y||0;
    const clone=source.clone();component.appendChild(clone);clone.x=0;clone.y=0;clone.visible=true;return {id:component.id,childId:clone.id};
  }
  if(c.action==='replace-instance') {
    const old=await get(c.nodeId),component=await get(c.componentId);if(component.type!=='COMPONENT')throw Error('Not component');
    if(!old.parent||old.type==='PAGE')throw Error('Invalid source');const parent=old.parent,index=parent.children.indexOf(old);
    const instance=component.createInstance();parent.insertChild(index,instance);instance.name=c.name||old.name;instance.rescale(old.width/component.width);instance.resize(old.width,old.height);instance.relativeTransform=old.relativeTransform;instance.opacity=old.opacity;instance.visible=old.visible;
    if('layoutAlign' in old)instance.layoutAlign=old.layoutAlign;if('layoutGrow' in old)instance.layoutGrow=old.layoutGrow;
    old.visible=false;old.name='原始备份 / '+old.name;return {id:instance.id,originalId:old.id,componentId:component.id};
  }
  throw Error('Unsupported design-system action: '+c.action);
}




async function executeLegacy(command, progress) {
    const page = await commandPage(command);
    const readTypes = [...API_CONTRACT.reads,'ping','bridge-capabilities','get-document-info','get-pages','get-node','get-fonts','export-node','validate-layout','operation-history'];
    if (!command.target && !readTypes.includes(command.type) && !(command.type === 'design-system' && command.action === 'inspect')) throw Error('Writes require an explicit controller binding; update the local bridge');
    let result;
    if (apiReads.has(command.type)||apiWrites.has(command.type)) return executeApiCommand(command,progress);
    if (command.type === "ping") {
      result = { pong: true, at: new Date().toISOString() };
    } else if (command.type === "bridge-capabilities") {
      result = {version:11, api:apiCapabilities(), visualReviewProtocol:1, fileCreation:{supported:false,alternative:"design-system page"}, reliabilityProtocol:1, layoutValidation:true, highLevelDsl:true, panelProtocol:1, controllerProtocol:1, pageIsolation:true, diagnostics:true, fontPreflight:true, textAlignment:{create:true,update:true,vertical:['TOP','CENTER','BOTTOM'],horizontal:['LEFT','CENTER','RIGHT','JUSTIFIED']}, commands:[...API_CONTRACT.reads,...API_CONTRACT.writes,'review-layout','repair-layout','batch','undo-operation','operation-history','validate-layout',...highLevelTypes,'design-system','get-fonts','import-image','build-section','update-node','get-document-info','get-pages','get-node','export-node']};
    } else if (command.type === "design-system") { result = await designSystemCommand(command); } else if (command.type === "get-fonts") {
      result = (await figma.listAvailableFontsAsync()).map(item => item.fontName);
    } else if (command.type === "import-image") {
      result = {imageHash:figma.createImage(figma.base64Decode(command.base64)).hash};
    } else if (command.type === "build-section") {
      result = await buildApiNodes(command,progress,page);
    } else if (command.type === "update-node") {
      const node=await apiNode(command.nodeId);await applyNodeProps(node,command.props);result={id:node.id,name:node.name};
    } else if (command.type === "get-document-info") {
      result = documentInfo(page);
    } else if (command.type === "get-pages") {
      await figma.loadAllPagesAsync();
      result = figma.root.children.map((page) => ({
        id: page.id, name: page.name,
        children: page.children.map((node) => ({
          id: node.id, name: node.name, type: node.type,
          width: node.width, height: node.height, visible: node.visible
        }))
      }));
    } else if (command.type === "get-node") {
      const node = await figma.getNodeByIdAsync(command.nodeId);
      if (!node) throw new Error("Node not found");
      const properties = [...API_CONTRACT.nodeProperties,"id","reactions","componentProperties","explicitVariableModes", "name", "type", "visible", "x", "y", "width", "height", "opacity", "rotation", "blendMode", "fills", "strokes", "strokeWeight", "strokeAlign", "effects", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "clipsContent", "layoutMode", "layoutSizingHorizontal", "layoutSizingVertical", "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing", "layoutGrow", "layoutAlign", "layoutPositioning", "constraints", "characters", "fontName", "fontSize", "fontWeight", "textAlignHorizontal", "textAlignVertical", "lineHeight", "letterSpacing", "textAutoResize", "textDecoration", "reactions", "exportSettings", "absoluteBoundingBox"];
      function serialize(current, depth) {
        const value = {};
        for (const key of properties) {
          try {
            const item = current[key];
            if (item !== undefined && typeof item !== "symbol") value[key] = JSON.parse(JSON.stringify(item));
          } catch (_) {}
        }
        if (current.type === "TEXT") {
          value.textSegments = current.getStyledTextSegments(["fontName", "fontSize", "fills", "lineHeight", "letterSpacing", "textDecoration"]);
        }
        if ("children" in current) {
          value.childCount = current.children.length;
          if (depth > 0) value.children = current.children.map((child) => serialize(child, depth - 1));
        }
        return value;
      }
      result = serialize(node, Math.min(command.depth == null ? 20 : command.depth, 50));
    } else if (command.type === "export-node") {
      const node = await figma.getNodeByIdAsync(command.nodeId);
      if (!node || !("exportAsync" in node)) throw new Error("Node cannot be exported");
      const settings=exportOptions(command),format=settings.format;
      const bytes = await node.exportAsync(settings);
      result = { nodeId: node.id, name: node.name, format, mimeType:({PNG:'image/png',JPG:'image/jpeg',SVG:'image/svg+xml',PDF:'application/pdf'})[format], base64: figma.base64Encode(bytes) };
    } else {
      throw new Error(`Unsupported command: ${command.type}`);
    }
    return result;
}
