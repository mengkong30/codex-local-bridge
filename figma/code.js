function validateTextAlignment(node, props) {
  const allowed = {textAlignVertical:['TOP','CENTER','BOTTOM'], textAlignHorizontal:['LEFT','CENTER','RIGHT','JUSTIFIED']};
  for (const key of Object.keys(allowed)) {
    if (props[key] === undefined) continue;
    if (node.type !== 'TEXT') throw new Error(key + ' requires a TEXT node');
    if (!allowed[key].includes(props[key])) throw new Error('Invalid ' + key + ': ' + props[key]);
  }
}

figma.showUI(__html__, { visible: true, width: 360, height: 220 });

function documentInfo() {
  return {
    fileKey: figma.fileKey || null,
    editorType: figma.editorType,
    fileName: figma.root.name,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    selection: figma.currentPage.selection.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type
    }))
  };
}

figma.ui.onmessage = async (message) => {
  if (message.type === "bridge-ready") {
    figma.ui.postMessage({ type: "figma-info", payload: documentInfo() });
    return;
  }

  if (message.type !== "bridge-command") return;

  const { requestId, command } = message;
  const startedAt = Date.now();
  const progress = (stage, details = {}) => figma.ui.postMessage({type:"bridge-progress",requestId,stage,elapsedMs:Date.now()-startedAt,...details});
  progress("started", {commandType:command.type});
  try {
    let result;
    if (command.type === "ping") {
      result = { pong: true, at: new Date().toISOString() };
    } else if (command.type === "bridge-capabilities") {
      result = {version:6, diagnostics:true, fontPreflight:true, textAlignment:{create:true,update:true,vertical:['TOP','CENTER','BOTTOM'],horizontal:['LEFT','CENTER','RIGHT','JUSTIFIED']}, commands:['design-system','get-fonts','import-image','build-section','update-node','get-document-info','get-pages','get-node','export-node']};
    } else if (command.type === "design-system") { result = await designSystemCommand(command); } else if (command.type === "get-fonts") {
      result = (await figma.listAvailableFontsAsync()).map(item => item.fontName);
    } else if (command.type === "import-image") {
      result = {imageHash:figma.createImage(figma.base64Decode(command.base64)).hash};
    } else if (command.type === "build-section") {
      const target = command.parentId ? await figma.getNodeByIdAsync(command.parentId) : figma.currentPage;
      if (!target || !('appendChild' in target)) throw new Error('Parent cannot contain nodes');
      const created = [];
      const fonts = new Map();
      function collectFonts(spec) {
        if (spec.kind === "TEXT") fonts.set(JSON.stringify(spec.fontName), spec.fontName);
        for (const child of spec.children || []) collectFonts(child);
      }
      for (const spec of command.nodes || []) collectFonts(spec);
      for (const font of fonts.values()) {
        progress("loading-font", {font});
        await figma.loadFontAsync(font);
      }
      progress("building", {fontCount:fonts.size});
      async function build(spec, parent) {
        let node;
        if (spec.kind === 'SVG') node = figma.createNodeFromSvg(spec.svg);
        else if (spec.kind === 'INSTANCE') {
          const source = await figma.getNodeByIdAsync(spec.componentId);
          if (!source || source.type !== 'COMPONENT') throw new Error('Missing component');
          node = source.createInstance();
        } else {
          const factories = {FRAME:'createFrame',COMPONENT:'createComponent',RECTANGLE:'createRectangle',ELLIPSE:'createEllipse',TEXT:'createText'};
          if (!factories[spec.kind]) throw new Error('Unsupported kind');
          node = figma[factories[spec.kind]]();
        }
        created.push(node); parent.appendChild(node);
        if (created.length === 1 || created.length % 20 === 0) progress("building", {created:created.length,nodeName:spec.name||spec.kind});
        if (spec.kind === 'TEXT') {
          node.fontName = spec.fontName;
        }
        const props = ['name','x','y','fills','strokes','strokeWeight','strokeAlign','cornerRadius','topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius','clipsContent','opacity','effects','fontSize','characters','textAlignHorizontal','textAlignVertical','textAutoResize','lineHeight','letterSpacing','layoutMode','paddingLeft','paddingRight','paddingTop','paddingBottom','itemSpacing','primaryAxisAlignItems','counterAxisAlignItems','primaryAxisSizingMode','counterAxisSizingMode'];
        validateTextAlignment(node, spec);
        for (const key of props) if (spec[key] !== undefined) node[key] = spec[key];
        if (spec.width !== undefined && spec.height !== undefined) node.resize(spec.width,spec.height);
        for (const child of spec.children || []) await build(child,node);
        return node;
      }
      try {
        const roots=[];
        for (const spec of command.nodes || []) roots.push(await build(spec,target));
        if (command.focus) { figma.currentPage.selection=roots;figma.viewport.scrollAndZoomIntoView(roots); }
        result={roots:roots.map(n=>({id:n.id,name:n.name,width:n.width,height:n.height})),nodes:created.map(n=>({id:n.id,name:n.name,type:n.type}))};
      } catch(error) {
        for (const node of created.reverse()) if (!node.removed) node.remove();
        throw error;
      }
    } else if (command.type === "update-node") {
      const node = await figma.getNodeByIdAsync(command.nodeId);
      if (!node) throw new Error('Node not found');
      validateTextAlignment(node, command.props);
      if (node.type==='TEXT') await figma.loadFontAsync(node.fontName);
      for(const key of ['x','y','name','fills','strokes','opacity','fontSize','characters','textAlignHorizontal','textAlignVertical','lineHeight','letterSpacing','visible','clipsContent']) if(command.props[key]!==undefined)node[key]=command.props[key];
      if(command.props.width!==undefined&&command.props.height!==undefined)node.resize(command.props.width,command.props.height);
      result={id:node.id};
    } else if (command.type === "get-document-info") {
      result = documentInfo();
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
      const properties = ["id", "name", "type", "visible", "x", "y", "width", "height", "opacity", "rotation", "blendMode", "fills", "strokes", "strokeWeight", "strokeAlign", "effects", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "clipsContent", "layoutMode", "layoutSizingHorizontal", "layoutSizingVertical", "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing", "layoutGrow", "layoutAlign", "layoutPositioning", "constraints", "characters", "fontName", "fontSize", "fontWeight", "textAlignHorizontal", "textAlignVertical", "lineHeight", "letterSpacing", "textAutoResize", "textDecoration", "reactions", "exportSettings", "absoluteBoundingBox"];
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
      const format = command.format || "SVG";
      if (format !== "SVG" && format !== "PNG") throw new Error("Supported formats: SVG, PNG");
      const settings = format === "SVG" ? { format: "SVG" } : { format: "PNG", constraint: { type: "SCALE", value: Math.min(command.scale || 1, 4) } };
      const bytes = await node.exportAsync(settings);
      result = { nodeId: node.id, name: node.name, format, base64: figma.base64Encode(bytes) };
    } else {
      throw new Error(`Unsupported command: ${command.type}`);
    }
    progress("completed");
    figma.ui.postMessage({ type: "bridge-result", requestId, ok: true, result });
  } catch (error) {
    figma.ui.postMessage({
      type: "bridge-result",
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
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
  if(c.action==='page') {let p=figma.root.children.find(p=>p.name===c.name);if(!p){p=figma.createPage();p.name=c.name;}await figma.setCurrentPageAsync(p);return {id:p.id,name:p.name};}
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



