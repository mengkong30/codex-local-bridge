const {chromium}=require(process.env.BRIDGE_PLAYWRIGHT_MODULE||'playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const port=38908,base='http://localhost:'+port;
const html=fs.readFileSync(path.join(__dirname,'figma/ui.html'),'utf8').replace('http://localhost:37821',base);
const server=spawn(process.execPath,[path.join(__dirname,'bridge-server.mjs')],{env:{...process.env,BRIDGE_PORT:String(port),BRIDGE_CONNECTION_TTL_MS:'2000',BRIDGE_WRITE_TIMEOUT_MS:'250'},stdio:['ignore','ignore','inherit'],windowsHide:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function post(route,p){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});return {status:r.status,...await r.json()};}
const health=async()=>(await fetch(base+'/health')).json();
(async()=>{
 let browser;
 try{
  for(let i=0;i<50;i++){try{if((await health()).ok)break;}catch{}await delay(50);}
  browser=await chromium.launch({headless:true,...(process.env.BRIDGE_BROWSER_CHANNEL?{channel:process.env.BRIDGE_BROWSER_CHANNEL}:{})});
  const page=await browser.newPage(),errors=[],hellos=[],resultIds=[];
  page.on('pageerror',e=>errors.push(e.message));
  let changeHelloIdentity=false,blockResult=false,allowResult,resultEntered;
  const resultGate=new Promise(resolve=>allowResult=resolve);
  const resultStarted=new Promise(resolve=>resultEntered=resolve);
  await page.route(base+'/hello',async route=>{const body=route.request().postDataJSON();hellos.push(body);const response=await route.fetch(),value=await response.json();if(changeHelloIdentity){changeHelloIdentity=false;value.connectionId='unexpected-identity';}await route.fulfill({response,json:value});});
  await page.route(base+'/result',async route=>{resultIds.push(route.request().postDataJSON().connectionId);resultEntered();if(blockResult)await resultGate;await route.continue();});
  await page.setContent('<html><body></body></html>');
  await page.evaluate(()=>{
   window.documentFixture={fileName:'Recovery fixture',bridgeVersion:11,panelProtocol:1,pageId:'p',pageName:'Test',pages:[{id:'p',name:'Test'}]};window.commands=[];
   window.addEventListener('message',e=>{const m=e.data?.pluginMessage;if(!m)return;const f=document.querySelector('iframe');if(m.type==='bridge-ready')f.contentWindow.postMessage({pluginMessage:{type:'figma-info',payload:window.documentFixture}},'*');if(m.type==='bridge-command')window.commands.push(m);});
  });
  await page.evaluate(html=>{const f=document.createElement('iframe');f.name='bridge';f.style.cssText='width:500px;height:740px';document.body.append(f);f.srcdoc=html;},html);
  const frame=page.frameLocator('iframe');await frame.locator('#connectionBadge').filter({hasText:'已连接'}).waitFor();
  const connectionId=(await health()).connections[0].connectionId;
  const clientId=(await post('/clients/register',{name:'Recovery acceptance',aiName:'Codex'})).clientId;
  const bindingId=(await post('/bindings',{clientId,connectionId,pageId:'p'})).binding.bindingId;
  const pending=post('/command',{clientId,connectionId,bindingId,type:'update-node',nodeId:'fixture',props:{x:1},idempotencyKey:'ui-late'});
  await page.waitForFunction(()=>window.commands.length===1);const first=await page.evaluate(()=>window.commands[0]);assert.equal((await pending).status,504);
  await delay(2200);assert.equal((await health()).connections.length,0);
  const send=async m=>page.locator('iframe').evaluate((f,m)=>f.contentWindow.postMessage({pluginMessage:m},'*'),m);
  const doc=await page.evaluate(()=>window.documentFixture);await send({type:'figma-info',payload:doc});
  await frame.locator('#connectionBadge').filter({hasText:'已连接'}).waitFor();
  assert.ok(hellos.some(h=>h.activeRequestId===first.requestId));
  let state=await health();assert.equal(state.connections.length,1);assert.equal(state.connections[0].connectionId,connectionId);assert.equal(state.connections[0].bindings[0].bindingId,bindingId);assert.equal(state.connections[0].uncertain,true);
  // A mismatched hello must remain blocked until the ORIGINAL result is acknowledged.
  changeHelloIdentity=true;await send({type:'figma-info',payload:doc});await frame.locator('#status').filter({hasText:'连接身份已改变'}).waitFor();
  assert.equal(await frame.locator('#compactReconnect').isVisible(),false);
  await send({type:'bridge-result',requestId:'unrelated-result',ok:true,result:{}});assert.equal(resultIds.length,0);
  blockResult=true;await send({type:'bridge-result',requestId:first.requestId,ok:true,result:{id:'fixture'}});
  await resultStarted;assert.equal(await frame.locator('#compactReconnect').isVisible(),false);
  allowResult();await frame.locator('#connectionBadge').filter({hasText:'已连接'}).waitFor();
  state=await health();assert.equal(state.connections.length,1);assert.equal(state.connections[0].connectionId,connectionId);assert.equal(state.connections[0].busy,false);assert.equal(state.connections[0].uncertain,false);assert.equal(state.connections[0].bindings[0].bindingId,bindingId);
  assert.deepEqual(resultIds,[connectionId]);assert.equal(await page.evaluate(()=>window.commands.length),1);
  // Existing binding remains usable; the UI does not replay the first mutation.
  const secondPending=post('/command',{clientId,connectionId,bindingId,type:'update-node',nodeId:'fixture',props:{x:2},idempotencyKey:'ui-next'});
  await page.waitForFunction(()=>window.commands.length===2);const second=await page.evaluate(()=>window.commands[1]);
  await send({type:'bridge-result',requestId:second.requestId,ok:true,result:{id:'fixture'}});assert.equal((await secondPending).ok,true);
  await post('/bindings/release',{clientId,bindingId});assert.deepEqual(errors,[]);
  console.log('PASS actual browser recovery: expired connection resumes original request/binding, unknown results ignored, identity mismatch stays blocked until result acknowledgement, auto recovery without reload and no write replay');
 }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
