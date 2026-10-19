import {optionsFromEnv,startCoordinatedServer,VERSION} from './bridge-discovery.mjs';
import http from 'node:http';
import apiContract from './api-contract.json' with {type:'json'};
import {createHash, randomUUID} from 'node:crypto';

const serviceOptions=optionsFromEnv();const host='127.0.0.1';let port=serviceOptions.port;
const TTL = Number(process.env.BRIDGE_CONNECTION_TTL_MS || 45000);
const LEASE = Number(process.env.BRIDGE_LEASE_MS || 300000);
const readTimeout = Number(process.env.BRIDGE_READ_TIMEOUT_MS || 15000);
const writeTimeout = Number(process.env.BRIDGE_WRITE_TIMEOUT_MS || 60000);
const MAX_BODY = 32 * 1024 * 1024;
const sessions = new Map(), clients = new Map(), bindings = new Map(), requests = new Map(), completed = new Map();
const offlineSessions = new Map();
const operations = new Map(), idempotency = new Map();
const operationTtl = 24 * 60 * 60 * 1000, operationLimit = 1000;
const instanceId = randomUUID();
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
function operationInfo(o) {return {requestId:o.requestId, connectionId:o.connectionId, state:o.state, idempotencyKey:o.idempotencyKey, createdAt:o.createdAt, result:o.result, instanceId, retentionMs:operationTtl};}
function settleOperation(task, status, result) {
  const o = operations.get(task.requestId); if (!o) return;
  o.state = status === 504 && task.dispatched ? 'uncertain' : result.ok ? 'succeeded' : 'failed';
  if (o.state !== 'uncertain') {o.result={status,...result};o.finishedAt=Date.now();}
}

let hubConnectionId = null, hubRevision = 0;
const supportsPanel = s => s?.document?.panelProtocol === 1;
function electHub() {
  const previous = hubConnectionId;
  if (!active(sessions.get(hubConnectionId)) || !supportsPanel(sessions.get(hubConnectionId))) hubConnectionId = null;
  if (!hubConnectionId) hubConnectionId = [...sessions.values()].find(s => active(s) && supportsPanel(s) && s.panelPreference !== 'compact')?.id || null;
  if (previous !== hubConnectionId) hubRevision++;
}
function hubInfo() { return {connectionId:hubConnectionId, fileName:sessions.get(hubConnectionId)?.document.fileName || null, revision:hubRevision}; }
function panelState(s) {
  return {ok:true, serverVersion:VERSION, instanceId, apiProtocol:1, recoveryProtocol:1, discoveryProtocol:1, profile:serviceOptions.profile, endpoint:'http://localhost:'+port, reliabilityProtocol:1, panelProtocol:1, self:info(s), hub:hubInfo(),
    connections:[...sessions.values()].filter(active).map(info).concat([...offlineSessions.values()])};
}
const origins = new Set(['null', 'https://www.figma.com', 'https://figma.com']);
const reads = new Set([...apiContract.reads,'ping', 'bridge-capabilities', 'get-document-info', 'get-pages', 'get-node', 'get-fonts', 'export-node','validate-layout','review-layout','operation-history']);
const writes = new Set([...apiContract.writes,'build-section', 'update-node', 'import-image', 'design-system','batch','undo-operation','create-panel','create-kpi-card','create-line-chart','create-donut-chart','create-digital-twin-map','create-component','create-variable-collection','apply-auto-layout','repair-layout']);
const fileActions = new Set(['page', 'collection', 'variable', 'text-style', 'effect-style']);
const isWrite = c => writes.has(c.type) && !(c.type === 'design-system' && c.action === 'inspect');
const needsFile = c => apiContract.fileWrites.includes(c.type) || c.type==='instance-action'&&!!c.componentKey || c.type === 'import-image' || c.type === 'create-variable-collection' || c.type === 'design-system' && fileActions.has(c.action) || c.type === 'batch' && (c.commands||[]).some(needsFile);
const fail = (message, status = 409) => { throw Object.assign(new Error(message), {status}); };
const active = s => s && !s.disconnected && !s.retired && Date.now() - s.seen < TTL;
function touchSession(s) {
  if(s.disconnected)fail('Target connection was explicitly disconnected');
  s.seen=Date.now();s.retired=false;delete s.disconnectedAt;offlineSessions.delete(s.id);
}
const used = id => [...requests.values()].some(t => t.bindingId === id) || [...sessions.values()].some(s => s.commandInfo?.bindingId === id);
function sweep() {
  for(const [id,o] of operations) if(o.finishedAt && Date.now()-o.finishedAt>operationTtl){operations.delete(id);if(o.key)idempotency.delete(o.key);}
  for (const s of sessions.values()) if (!active(s)) {
    s.retired = true; s.disconnectedAt ||= new Date().toISOString();
    if (!s.historyDismissed && !offlineSessions.has(s.id) && Date.now() - new Date(s.disconnectedAt).getTime() <= LEASE) offlineSessions.set(s.id, {...info(s), connected:false, disconnectedAt:s.disconnectedAt});
  }
  for (const [id, s] of offlineSessions) if (Date.now() - new Date(s.disconnectedAt).getTime() > LEASE || active(sessions.get(id))) offlineSessions.delete(id);
  while (offlineSessions.size > 32) offlineSessions.delete(offlineSessions.keys().next().value);
  for (const [id, b] of bindings) if ((!active(sessions.get(b.connectionId)) || b.expiresAt <= Date.now()) && !used(id)) bindings.delete(id);
  for (const [id, c] of clients) if (Date.now() - c.seen > LEASE && ![...operations.values()].some(o=>o.clientId===id) && ![...bindings.values()].some(b => b.clientId === id)) clients.delete(id);
  for (const [id, s] of sessions) if (!active(s) && !s.busy && !s.queue.length && !s.waiter) sessions.delete(id);
  electHub();
}
function publicBinding(b) {
  const s = sessions.get(b.connectionId), c = clients.get(b.clientId);
  return {...b, aiName:c?.aiName || '未知 AI', clientName:c?.name || '未知任务',
    pageName:s?.document.pages?.find(p => p.id === b.pageId)?.name || b.pageName,
    expiresAt:new Date(b.expiresAt).toISOString(), state:!active(s) ? 'disconnected' : s.uncertain && s.commandInfo?.bindingId === b.bindingId ? 'uncertain' : s.commandInfo?.bindingId === b.bindingId ? 'running' : s.queue.some(t => t.bindingId === b.bindingId) ? 'queued' : b.expiresAt <= Date.now() ? 'expired' : 'idle'};
}
function info(s) {
  return {...s.document, connectionId:s.id, connected:!!active(s), lastSeen:new Date(s.seen).toISOString(), busy:!!s.busy, uncertain:!!s.uncertain,
    queueLength:s.queue.length, command:s.commandInfo || null, progress:s.progress || null, lastResult:s.lastResult || null,
    bindings:[...bindings.values()].filter(b => b.connectionId === s.id).map(publicBinding)};
}
function json(res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  const headers = {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', vary:'Origin'};
  if (res.allowedOrigin) Object.assign(headers, {'access-control-allow-origin':res.allowedOrigin, 'access-control-allow-headers':'content-type', 'access-control-allow-methods':'GET,POST,OPTIONS'});
  res.writeHead(status, headers); res.end(JSON.stringify(value));
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) fail('Request body exceeds 32 MiB', 413); chunks.push(chunk); }
  const p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('JSON object required', 400);
  return p;
}
function session(id) { const s = sessions.get(id); if (!active(s)) fail('Target connection is disconnected or expired'); return s; }
function client(id) { const c = clients.get(id); if (!c) fail('Register this client first'); c.seen = Date.now(); return c; }
function binding(p) {
  const b = bindings.get(p.bindingId);
  if (!b || b.expiresAt <= Date.now()) fail('Binding expired or released; bind the intended page again');
  if (b.clientId !== p.clientId) fail('Binding belongs to another client');
  if (p.connectionId && p.connectionId !== b.connectionId) fail('connectionId conflicts with bound target');
  if (p.pageId && p.pageId !== b.pageId) fail('pageId conflicts with bound target');
  session(b.connectionId); client(p.clientId); b.expiresAt = Date.now() + LEASE;
  return b;
}
function pump(s) {
  if (s.busy || s.uncertain || !s.waiter || !active(s)) return;
  while (s.queue.length) {
    const task = s.queue.shift(); if (!requests.has(task.requestId)) continue;
    if (task.bindingId) {
      const b = bindings.get(task.bindingId);
      if (!b || b.expiresAt <= Date.now()) { finish(task, 409, {ok:false, error:'Queued binding expired or released'}); continue; }
    }
    const res = s.waiter; s.waiter = null; s.busy = task.requestId; task.dispatched = true;const o=operations.get(task.requestId);if(o)o.state='running';
    s.commandInfo = {requestId:task.requestId, type:task.command.type, bindingId:task.bindingId,
      ...task.command.target, dispatchedAt:new Date().toISOString()}; s.progress = null;
    json(res, 200, {requestId:task.requestId, connectionId:s.id, command:task.command}); return;
  }
}
function finish(task, status, result) { requests.delete(task.requestId); clearTimeout(task.timer); settleOperation(task, status, result); json(task.res, status, result); }
function release(id, connectionId) {
  const b = bindings.get(id); if (!b) fail('Binding already expired or released');
  if (connectionId && b.connectionId !== connectionId) fail('Binding belongs to another connection');
  if (used(id)) fail('This controller has running, queued or unresolved work; wait for its result before releasing');
  bindings.delete(id); return {ok:true};
}

const server = http.createServer(async (req, res) => {
  try {
    if (![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(req.headers.host)) fail('Local requests only', 403);
    if (req.headers.origin && !origins.has(req.headers.origin)) fail('Browser origin is not allowed', 403);
    res.allowedOrigin = req.headers.origin;
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail('application/json required', 415);
    if (Number(req.headers['content-length']) > MAX_BODY) fail('Request body exceeds 32 MiB', 413);
    sweep(); const url = new URL(req.url, `http://${host}:${port}`), path = url.pathname;
    if (req.method === 'GET' && path === '/health') return json(res, 200, {ok:true, serverName:'codex-local-bridge', protocolVersion:2, serverVersion:VERSION, instanceId, apiProtocol:1, recoveryProtocol:1, discoveryProtocol:1, profile:serviceOptions.profile, endpoint:'http://localhost:'+port, reliabilityProtocol:1, controllerProtocol:1, panelProtocol:1, hub:hubInfo(), figmaConnected:[...sessions.values()].some(active), connections:[...sessions.values()].filter(active).map(info)});
    if (req.method === 'GET' && path === '/operations') {
      const clientId=url.searchParams.get('clientId');client(clientId);
      const key=url.searchParams.get('idempotencyKey'), connectionId=url.searchParams.get('connectionId');
      const id=url.searchParams.get('requestId') || idempotency.get(stable([connectionId,clientId,key]));
      const o=operations.get(id);if(!o || o.clientId!==clientId || o.connectionId!==connectionId) fail('Operation not found in this service instance; do not replay an unknown write',404);
      return json(res,200,{ok:true,operation:operationInfo(o)});
    }
    if (req.method === 'GET' && path === '/panel') return json(res, 200, panelState(session(url.searchParams.get('connectionId'))));
    if (req.method === 'GET' && path === '/connection') return json(res, 200, {ok:true, connection:info(session(url.searchParams.get('connectionId')))});
    if (req.method === 'GET' && path === '/next') {
      const s = session(url.searchParams.get('connectionId')); s.seen = Date.now();
      if (s.waiter) json(s.waiter, 200, {}); s.waiter = res; pump(s);
      const timer = setTimeout(() => { if (s.waiter === res) {s.waiter = null; json(res, 200, {});} }, 20000);
      res.on('close', () => { clearTimeout(timer); if (s.waiter === res) s.waiter = null; }); return;
    }
    if (req.method !== 'POST') return json(res, 404, {ok:false, error:'Not found'});
    const p = await readJson(req);
    if (path === '/hello') {
      if (p.protocolVersion !== 2) fail('Updated Figma plugin required: protocolVersion 2', 400);
      let s = sessions.get(p.connectionId);
      // An expired worker must acknowledge its exact in-flight request before
      // resuming. Never replace an unresolved connection with a second writer.
      if(s?.busy){
        if((!active(s)||p.activeRequestId)&&p.activeRequestId!==s.busy)fail('Connection has an unfinished request; resume with its exact activeRequestId');
        touchSession(s);
      }else if(p.activeRequestId)fail('Active request is unknown to this service; verify its outcome before reconnecting');
      if (!active(s)) { s = {id:randomUUID(), queue:[], busy:null, uncertain:false, waiter:null}; sessions.set(s.id, s); }
      s.document = p.document || {}; s.seen = Date.now();
      electHub();
      return json(res, 200, {ok:true, connectionId:s.id, serverVersion:VERSION, instanceId, apiProtocol:1, recoveryProtocol:1, discoveryProtocol:1, profile:serviceOptions.profile, endpoint:'http://localhost:'+port, reliabilityProtocol:1, controllerProtocol:1, panelProtocol:1, hub:hubInfo()});
    }
    if (path === '/panel/promote') {
      const caller = session(p.connectionId), target = session(p.targetConnectionId || p.connectionId);
      if (!supportsPanel(caller) || !supportsPanel(target)) fail('Reopen the updated Figma plugin (panel protocol 1 required)');
      if (caller.id !== target.id && hubConnectionId !== caller.id) fail('Only the current hub can promote another file');
      target.panelPreference = 'auto';
      if (hubConnectionId !== target.id) {hubConnectionId = target.id; hubRevision++;}
      return json(res, 200, {ok:true, hub:hubInfo()});
    }
    if (path === '/panel/compact') {
      const s = session(p.connectionId); if (!supportsPanel(s)) fail('Updated panel required');
      s.panelPreference = 'compact'; if (hubConnectionId === s.id) {hubConnectionId = null; hubRevision++;}
      electHub(); return json(res, 200, {ok:true, hub:hubInfo()});
    }
    if (path === '/panel/forget') {
      const caller = session(p.connectionId);
      if (hubConnectionId !== caller.id) fail('Only the current hub can delete offline records');
      if (active(sessions.get(p.targetConnectionId))) fail('Connected files cannot be removed');
      const target = sessions.get(p.targetConnectionId);
      if (target) target.historyDismissed = true;
      offlineSessions.delete(p.targetConnectionId);
      return json(res, 200, {ok:true});
    }
    if (path === '/panel/release') {
      const caller = session(p.connectionId); if (hubConnectionId !== caller.id) fail('Only the current hub can release another file binding');
      const target = session(p.targetConnectionId);
      return json(res, 200, release(p.bindingId, target.id));
    }
    if (path === '/clients/register') {
      if (typeof p.name !== 'string' || !p.name.trim() || typeof p.aiName !== 'string' || !p.aiName.trim()) fail('name and aiName are required', 400);
      const c = {clientId:randomUUID(), name:p.name.trim().slice(0, 120), aiName:p.aiName.trim().slice(0, 60), seen:Date.now()};
      clients.set(c.clientId, c); return json(res, 200, {ok:true, ...c, leaseMs:LEASE});
    }
    if (path === '/bindings') {
      client(p.clientId); const s = session(p.connectionId), scope = p.scope || 'page';
      if (!(s.document.bridgeVersion >= 7) || !Array.isArray(s.document.pages)) fail('Restart the updated Figma plugin (bridge v7 required)');
      if (!['page', 'file'].includes(scope)) fail('scope must be page or file', 400);
      const page = s.document.pages.find(page => page.id === p.pageId); if (!page) fail('Target page is missing; refresh page list');
      if (s.uncertain) fail('File has an unresolved command; wait for its result');
      const others = [...bindings.values()].filter(b => b.connectionId === s.id);
      const same = others.find(b => b.clientId === p.clientId && b.pageId === page.id && b.scope === scope);
      if (same) {same.expiresAt = Date.now() + LEASE; return json(res, 200, {ok:true, binding:publicBinding(same), leaseMs:LEASE});}
      if (others.some(b => scope === 'file' || b.scope === 'file' || b.pageId === page.id)) fail('Target is controlled by another binding; choose another page or release it first');
      const b = {bindingId:randomUUID(), clientId:p.clientId, connectionId:s.id, fileName:s.document.fileName, pageId:page.id, pageName:page.name, scope, expiresAt:Date.now() + LEASE};
      bindings.set(b.bindingId, b); return json(res, 200, {ok:true, binding:publicBinding(b), leaseMs:LEASE});
    }
    if (path === '/bindings/heartbeat') { const b = binding(p); return json(res, 200, {ok:true, binding:publicBinding(b), leaseMs:LEASE}); }
    if (path === '/bindings/release') { const b = binding(p); return json(res, 200, release(b.bindingId)); }
    if (path === '/bindings/revoke') { session(p.connectionId); return json(res, 200, release(p.bindingId, p.connectionId)); }
    if (path === '/disconnect') {
      const s = session(p.connectionId); if (s.busy || s.queue.length || s.uncertain) fail('Wait for running, queued or unresolved work before disconnecting');
      s.disconnected = true; if (s.waiter) {json(s.waiter, 200, {}); s.waiter = null;}
      for (const [id, b] of bindings) if (b.connectionId === s.id) bindings.delete(id);
      electHub();
      return json(res, 200, {ok:true});
    }
    if (path === '/progress') {
      const s = sessions.get(p.connectionId); if (!s || s.busy !== p.requestId) fail('Progress does not match active request');
      touchSession(s);electHub();s.progress = {requestId:p.requestId, stage:p.stage, elapsedMs:p.elapsedMs, font:p.font, created:p.created, nodeName:p.nodeName, changedNodes:p.changedNodes,restoredNodes:p.restoredNodes,totalNodes:p.totalNodes,receivedAt:new Date().toISOString()};
      return json(res, 200, {ok:true});
    }
    if (path === '/result') {
      const s = sessions.get(p.connectionId), task = requests.get(p.requestId);
      if (completed.get(p.requestId)?.connectionId === p.connectionId) return json(res, 200, {ok:true, duplicate:true});
      if (!s || s.busy !== p.requestId || (task && task.connectionId !== s.id)) fail('Result does not match target connection');
      s.lastResult = {...s.commandInfo, ok:p.ok, error:p.error, completedAt:new Date().toISOString(), roots:p.result?.roots, nodeId:p.result?.nodeId || p.result?.id};
      completed.set(p.requestId, {connectionId:s.id}); if (completed.size > 256) completed.delete(completed.keys().next().value);
      settleOperation({requestId:p.requestId,dispatched:true},200,{...p,connectionId:s.id});
      const b = bindings.get(s.commandInfo?.bindingId); if (b) b.expiresAt = Date.now() + LEASE;
      touchSession(s);s.busy = null; s.uncertain = false; s.commandInfo = null;electHub();
      if (task) finish(task, 200, {...p, connectionId:s.id}); pump(s); return json(res, 200, {ok:true});
    }
    if (path === '/command') {
      if (!reads.has(p.type) && !writes.has(p.type)) fail('Unsupported command type', 400);
      if (p.pageId && !p.bindingId) fail('pageId requires an explicit bindingId; do not depend on the visible page');
      let b, s;
      if (p.bindingId) { b = binding(p); s = session(b.connectionId); }
      else {
        if (isWrite(p)) fail('Writes require clientId and bindingId; bind an explicit page first');
        const list = [...sessions.values()].filter(active);
        if (p.connectionId) s = session(p.connectionId);
        else if (list.length === 1) s = list[0];
        else fail(list.length ? 'Multiple files connected; specify connectionId' : 'No Figma connection available');
      }
      if(s.document.editorType==='dev'&&isWrite(p))fail('Dev Mode is read-only; use Design to write');
      if([...apiContract.reads,...apiContract.writes].includes(p.type)&&!(s.document.bridgeVersion>=11))fail('Reopen Figma plugin runtime v11 for expanded API commands');
      let operationKey, fingerprint;
      if (p.idempotencyKey !== undefined) {
        if (!b || typeof p.idempotencyKey!=='string' || !p.idempotencyKey.trim() || p.idempotencyKey.length>160) fail('idempotencyKey requires a binding and 1–160 characters',400);
        operationKey=stable([s.id,b.clientId,p.idempotencyKey]);
        const {bindingId,clientId,connectionId,...payload}=p; fingerprint=createHash('sha256').update(stable(payload)).digest('hex');
        const previous=operations.get(idempotency.get(operationKey));
        if(previous){if(previous.fingerprint!==fingerprint)fail('Idempotency key reused with a different command',409);
          return json(res,previous.result?.status||202,previous.result?{...previous.result,duplicate:true,operation:operationInfo(previous)}:{ok:true,pending:true,operation:operationInfo(previous)});}
      }
      if ((isWrite(p)||operationKey) && operations.size>=operationLimit) fail('Operation history is full; existing keys remain protected until retention expires',429);
      if(['review-layout','repair-layout'].includes(p.type)&&!(s.document.bridgeVersion>=10))fail('Reopen Figma plugin runtime v10 for visual review/repair');
      if ((isWrite(p)||['validate-layout','operation-history'].includes(p.type)) && !(s.document.bridgeVersion>=9)) fail('Reopen Figma plugin bridge v9 before reliable writes, dry-run or validation');
      if (s.uncertain) fail('Previous command outcome is uncertain; wait for its result or restart this Figma plugin');
      if (b?.scope === 'page' && needsFile(p)) fail('Document-wide operation requires an exclusive file binding (scope: file)');
      if (p.target !== undefined) fail('target is assigned by the bridge; use bindingId', 400);
      const {connectionId, clientId, bindingId, pageId, ...command} = p;
      if (b) { const c = client(b.clientId); command.target = {bindingId:b.bindingId, clientId:b.clientId, clientName:c.name, aiName:c.aiName, fileName:s.document.fileName, pageId:b.pageId, pageName:b.pageName, scope:b.scope}; }
      const requestId = randomUUID(), task = {requestId, connectionId:s.id, bindingId:b?.bindingId, command, res, dispatched:false};
      requests.set(requestId, task);
      const operation={requestId,connectionId:s.id,clientId:b?.clientId,state:'queued',createdAt:new Date().toISOString(),key:operationKey,fingerprint,idempotencyKey:p.idempotencyKey};
      if(isWrite(command)||operationKey)operations.set(requestId,operation);if(operationKey)idempotency.set(operationKey,requestId);
      task.timer = setTimeout(() => {
        requests.delete(requestId); s.queue = s.queue.filter(t => t !== task);
        if (task.dispatched) { s.uncertain = true; for (const queued of s.queue) finish(queued, 409, {ok:false, error:'Stopped: previous command outcome is uncertain', connectionId:s.id}); s.queue = []; }
        const timeoutResult={ok:false, error:task.dispatched ? 'Command timed out; outcome uncertain. Do not retry writes blindly.' : 'Command expired before dispatch', connectionId:s.id, requestId, progress:s.progress || null};settleOperation(task,504,timeoutResult);json(res,504,timeoutResult);
      }, isWrite(command) || ['export-node','validate-layout','review-layout'].includes(command.type) ? writeTimeout : readTimeout);
      s.queue.push(task); pump(s); return;
    }
    json(res, 404, {ok:false, error:'Not found'});
  } catch (error) { json(res, error.status || 400, {ok:false, error:error.message}); }
});
try{const started=await startCoordinatedServer(server,serviceOptions,{instanceId,serverVersion:VERSION});port=started.port;console.log(`Codex Local Bridge ${VERSION} (${started.profile}) listening on http://${host}:${port}`);}catch(error){console.error(error.message);process.exitCode=error.code==='INSTANCE_EXISTS'?0:1;}
