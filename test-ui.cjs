const {chromium}=require(process.env.BRIDGE_PLAYWRIGHT_MODULE || 'playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const port=37832,base='http://localhost:'+port,out=process.env.BRIDGE_UI_OUTPUT||path.resolve(__dirname,'output/ui');
fs.mkdirSync(out,{recursive:true});
const html=fs.readFileSync(path.join(__dirname,'figma/ui.html'),'utf8').replace('http://localhost:37821',base);
const server=spawn(process.execPath,[path.join(__dirname,'bridge-server.mjs')],{env:{...process.env,BRIDGE_PORT:String(port),BRIDGE_READ_TIMEOUT_MS:'5000',BRIDGE_WRITE_TIMEOUT_MS:'20000'},stdio:['ignore','ignore','inherit'],windowsHide:true});
async function post(route,p){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});return {status:r.status,...await r.json()};}
async function health(){return (await fetch(base+'/health')).json();}
const fixtureA={fileName:'示例文件 A',pageId:'p1',pageName:'示例页面 A',bridgeVersion:11,panelProtocol:1,pages:[{id:'p2',name:'示例页面 B'},{id:'p1',name:'示例页面 A'}],selection:[]};
const fixtureB={fileName:'示例文件 B',pageId:'p1',pageName:'示例页面 C',bridgeVersion:11,panelProtocol:1,pages:[{id:'p1',name:'示例页面 C'},{id:'p2',name:'示例页面 D'}],selection:[]};
(async()=>{
 let browser;
 try{
  for(let i=0;i<50;i++){try{if((await health()).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  browser=await chromium.launch({headless:true,...(process.env.BRIDGE_BROWSER_CHANNEL?{channel:process.env.BRIDGE_BROWSER_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:960,height:820},deviceScaleFactor:2}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<html><body style="margin:0;padding:12px;font:12px Segoe UI;display:flex;gap:16px;align-items:flex-start"></body></html>');
  await page.evaluate(({A,B})=>{
   window.fixtures={A,B};window.pendingCommands={A:[],B:[]};window.resizes=[];
   window.addEventListener('message',event=>{
    const frame=[...document.querySelectorAll('iframe')].find(f=>f.contentWindow===event.source),m=event.data?.pluginMessage;if(!frame||!m)return;
    if(m.type==='bridge-ready')frame.contentWindow.postMessage({pluginMessage:{type:'figma-info',payload:window.fixtures[frame.id]}},'*');
    if(m.type==='bridge-save-settings'){window.fixtures[frame.id].connectionSettings=m.settings;frame.contentWindow.postMessage({pluginMessage:{type:'bridge-settings-saved'}},'*');}
    if(m.type==='bridge-settings-size'){frame.style.width=(m.open||m.mode==='hub'?500:400)+'px';frame.style.height=(m.open||m.mode==='hub'?740:148)+'px';}
    if(m.type==='bridge-panel-mode'){frame.style.width=(m.mode==='hub'?500:400)+'px';frame.style.height=(m.mode==='hub'?740:148)+'px';window.resizes.push({id:frame.id,mode:m.mode});}
    if(m.type==='bridge-command'){
     const command=m.command;
     if(command.type==='build-section')window.pendingCommands[frame.id].push(m);
     else{const d=window.fixtures[frame.id],target=d.pages.find(p=>p.id===command.target?.pageId)||{id:d.pageId,name:d.pageName};frame.contentWindow.postMessage({pluginMessage:{type:'bridge-result',requestId:m.requestId,ok:true,result:command.type==='get-document-info'?{...d,pageId:target.id,pageName:target.name,viewingPageId:d.pageId}:{pong:true}}},'*');}
    }
   });
  },{A:fixtureA,B:fixtureB});
  async function add(id){await page.evaluate(({id,html})=>{const f=document.createElement('iframe');f.id=id;f.name=id;f.title='Figma '+id;f.style.cssText='border:1px solid #e5e7eb;width:500px;height:740px;flex:none';document.body.append(f);f.srcdoc=html;},{id,html});return page.frameLocator('#'+id);}
  async function send(id,m){await page.locator('#'+id).evaluate((f,m)=>f.contentWindow.postMessage({pluginMessage:m},'*'),m);}
  async function mode(frame,value){await frame.locator('#app[data-mode="'+value+'"]').waitFor();}
  // A temporary old service reply must not permanently block reconnect.
  let downgrade=true;
  await page.route(base+'/hello',async route=>{const r=await route.fetch();const p=await r.json();if(downgrade){downgrade=false;delete p.panelProtocol;}await route.fulfill({response:r,json:p});});
  const a=await add('A');await a.locator('#status').filter({hasText:'服务版本不兼容'}).waitFor();
  await a.locator('summary').filter({hasText:'本窗口的连接信息'}).click();
  await a.getByRole('button',{name:'重新连接本窗口'}).click();await a.locator('#connectionBadge').filter({hasText:'主控 · 已连接'}).waitFor();
  await a.getByRole('button',{name:'设置',exact:true}).first().click();await a.getByRole('button',{name:'检查版本',exact:true}).click();await a.locator('#settingsResult').filter({hasText:'版本兼容'}).waitFor();
  await a.locator('#connectionProfile').fill('invalid profile');await a.getByRole('button',{name:'保存并连接'}).click();await a.locator('#settingsResult').filter({hasText:'配置名称只能'}).waitFor();
  await a.locator('#connectionProfile').fill('port-'+port);await a.locator('#connectionMode').selectOption('manual');await a.getByRole('button',{name:'保存并连接'}).click();await a.locator('#connectionBadge').filter({hasText:'主控 · 已连接'}).waitFor();await a.getByRole('button',{name:'返回',exact:true}).click();
  const b=await add('B');await mode(b,'compact');await mode(a,'hub');
  await b.getByRole('button',{name:'设置',exact:true}).click();await b.locator('#settingsPanel').waitFor();assert.equal(await page.locator('#B').evaluate(n=>n.style.height),'740px');await page.screenshot({path:path.join(out,'connection-settings.png'),fullPage:true});await b.getByRole('button',{name:'返回',exact:true}).click();assert.equal(await page.locator('#B').evaluate(n=>n.style.height),'148px');

  let s=await health(),aid=s.connections.find(c=>c.fileName==='示例文件 A').connectionId,bid=s.connections.find(c=>c.fileName==='示例文件 B').connectionId;
  let releasePanel;const panelGate=new Promise(resolve=>releasePanel=resolve);let holdPanel=true;
  await page.route(base+'/panel?connectionId='+aid,async route=>{if(holdPanel)await panelGate;await route.continue();});
  await a.getByRole('button',{name:'刷新',exact:true}).click();
  await a.getByRole('button',{name:'刷新中…',exact:true}).waitFor();
  assert.equal(await a.getByRole('button',{name:'刷新中…',exact:true}).isDisabled(),true);
  holdPanel=false;releasePanel();await a.locator('#status').filter({hasText:'文件状态已刷新'}).waitFor();
  await b.getByRole('button',{name:'刷新',exact:true}).click();await b.locator('#status').filter({hasText:'文件状态已刷新'}).waitFor();
  const ca=(await post('/clients/register',{name:'示例任务 A',aiName:'Codex'})).clientId,cb=(await post('/clients/register',{name:'示例任务 B',aiName:'DeepSeek'})).clientId;
  const ba=(await post('/bindings',{clientId:ca,connectionId:aid,pageId:'p1'})).binding,bb=(await post('/bindings',{clientId:cb,connectionId:bid,pageId:'p1'})).binding;
  await a.locator('[data-connection="'+bid+'"]').click();await a.locator('#pages').getByText('DeepSeek',{exact:false}).waitFor();
  assert.equal(await a.locator('#fileName').textContent(),'示例文件 B');assert.equal(await b.locator('#compactFile').textContent(),'示例文件 B');
  // A collapsed worker still receives commands and reports progress/results.
  const pending=post('/command',{clientId:cb,bindingId:bb.bindingId,type:'build-section',nodes:[]});
  await page.waitForFunction(()=>window.pendingCommands.B.length>0);
  const cmd=await page.evaluate(()=>window.pendingCommands.B[0]);
  await send('B',{type:'bridge-progress',requestId:cmd.requestId,stage:'building',created:128});
  await a.locator('#execution').filter({hasText:'已创建 128 个图层'}).waitFor();
  await b.locator('#connectionBadge').filter({hasText:'执行中'}).waitFor();
  assert.equal(await b.locator('#disconnect').isDisabled(),true);
  assert.ok(await a.locator('#execution').evaluate(n=>n.getBoundingClientRect().bottom<=document.querySelector('.hub-body').getBoundingClientRect().bottom),'Execution should fit in the standard two-page viewport');
  assert.ok(await b.locator('body').evaluate(n=>n.scrollHeight<=n.clientHeight),'Compact strip must fit its native height');
  await page.screenshot({path:path.join(out,'hub-and-compact.png'),fullPage:true});
  await b.getByRole('button',{name:'设为主控',exact:true}).click();await mode(b,'hub');await mode(a,'compact');
  assert.equal((await health()).hub.connectionId,bid);
  assert.deepEqual((await health()).connections.flatMap(c=>c.bindings).map(b=>b.bindingId).sort(),[ba.bindingId,bb.bindingId].sort());
  await b.getByRole('button',{name:'精简',exact:true}).click();await mode(b,'compact');await mode(a,'hub');
  assert.equal((await health()).connections.find(c=>c.connectionId===bid).busy,true);
  let resultAttempts=0;
  await page.route(base+'/result',async route=>{resultAttempts++;if(resultAttempts===1)return route.abort();await route.continue();});
  await send('B',{type:'bridge-result',requestId:cmd.requestId,ok:true,result:{roots:[]}});
  assert.equal((await pending).ok,true);assert.ok(resultAttempts>=2);
  await a.getByRole('button',{name:'释放 DeepSeek 对 示例页面 C 的控制',exact:true}).click();
  await a.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await health()).connections.find(c=>c.connectionId===bid).bindings.length,1);
  await a.getByRole('button',{name:'释放 DeepSeek 对 示例页面 C 的控制',exact:true}).click();
  await a.getByRole('button',{name:'确认释放',exact:true}).click();
  await a.locator('#status').filter({hasText:'已释放所选页面'}).waitFor();assert.equal((await health()).connections.find(c=>c.connectionId===bid).bindings.length,0);
  // Remote promotion is display-only. Disconnect always targets the local worker.
  await a.getByRole('button',{name:'在此文件显示主控',exact:true}).click();await mode(b,'hub');await mode(a,'compact');
  await b.locator('[data-connection="'+aid+'"]').click();
  await b.locator('summary').filter({hasText:'本窗口的连接信息'}).click();await b.getByRole('button',{name:'断开本窗口连接',exact:true}).click();
  await b.locator('#connectionBadge').filter({hasText:'已断开'}).waitFor();await mode(b,'compact');await mode(a,'hub');
  await a.locator('[data-connection="'+bid+'"]').filter({hasText:'已断线'}).waitFor();
  assert.equal((await health()).connections.some(c=>c.connectionId===aid),true);
  await b.getByRole('button',{name:'重新连接',exact:true}).click();await mode(b,'compact');
  await b.locator('#connectionBadge').filter({hasText:'空闲'}).waitFor();
  const remove=a.getByRole('button',{name:'删除 示例文件 B 的断线记录',exact:true});await remove.waitFor();await remove.click();
  await a.locator('[data-connection="'+bid+'"]').waitFor({state:'detached'});
  await a.getByRole('button',{name:'刷新',exact:true}).click();
  assert.equal(await a.locator('[data-connection="'+bid+'"]').count(),0);
  const newBid=(await health()).connections.find(c=>c.fileName==='示例文件 B').connectionId;assert.notEqual(newBid,bid);
  // Native null-source messages remain accepted; long names fit both modes.
  await a.locator('body').evaluate((_,payload)=>window.dispatchEvent(new MessageEvent('message',{source:null,data:{pluginMessage:{type:'figma-info',payload}}})),fixtureA);
  await a.locator('[data-connection="'+aid+'"]').click();
  assert.match(await a.locator('#pages .page').first().textContent(),/示例页面 A/);
  await page.evaluate(()=>{window.fixtures.A.fileName='一个很长的文件名称'.repeat(8);});
  const long=await page.evaluate(()=>window.fixtures.A);await send('A',{type:'figma-info',payload:long});await a.locator('#fileName').filter({hasText:'一个很长的文件名称'}).waitFor();
  await page.locator('#A').evaluate(f=>f.style.width='320px');
  const dims=await a.locator('body').evaluate(n=>({w:n.clientWidth,s:n.scrollWidth}));assert.ok(dims.s<=dims.w,JSON.stringify(dims));
  await page.screenshot({path:path.join(out,'hub-long-content.png'),fullPage:true});
  await page.locator('#A').evaluate(f=>f.style.width='500px');await page.emulateMedia({colorScheme:'dark'});
  await page.screenshot({path:path.join(out,'hub-dark.png'),fullPage:true});
  if(!(await a.locator('details.connection').evaluate(n=>n.open)))await a.locator('summary').filter({hasText:'本窗口的连接信息'}).click();
  await a.getByRole('button',{name:'断开本窗口连接',exact:true}).click();await mode(a,'compact');
  await b.getByRole('button',{name:'设为主控',exact:true}).click();await mode(b,'hub');
  await a.getByRole('button',{name:'重新连接',exact:true}).click();await mode(a,'compact');
  await post('/bindings/release',{clientId:ca,bindingId:ba.bindingId}); // Already invalidated by disconnect; harmless fixture cleanup.
  assert.deepEqual(errors,[]);
  console.log('PASS actual UI/server: manual refresh in hub/compact, loading/disabled/success feedback, two connected windows, one hub, native handshake, service recovery, compact command execution, progress/retry, transfer during work, unchanged bindings, remote release, disconnect failover, offline history, reconnect, sorted pages, 320px names, dark mode');
 }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
