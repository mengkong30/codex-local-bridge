#!/usr/bin/env node
/**
 * DeepSeek Harness adapter for codex-local-bridge.
 * Zero dependencies. Node.js >= 22.
 *
 * The bridge and Figma plugin are MIT-licensed. See ../LICENSE.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, '..');
const bridgeRoot = process.env.FIGMA_BRIDGE_ROOT
  ? path.resolve(process.env.FIGMA_BRIDGE_ROOT)
  : skillRoot;
const port = Number(process.env.BRIDGE_PORT || 37821);
let baseUrl = `http://127.0.0.1:${port}`;
const manifestPath = path.join(bridgeRoot, 'figma', 'manifest.json');
const bridgeServer = path.join(bridgeRoot, 'bridge-server.mjs');
const args = process.argv.slice(2);
const commandName = args[0] || 'help';

const writeJson = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

function printHelp() {
  console.log(`DeepSeek local Figma bridge

Usage:
  node adapters/dsh-bridge.mjs settings [--profile default]
  node adapters/dsh-bridge.mjs review <nodeId> --out review.json --binding <id> --client <id>
  node adapters/dsh-bridge.mjs status
  node adapters/dsh-bridge.mjs start
  node adapters/dsh-bridge.mjs connect
  node adapters/dsh-bridge.mjs bind --connection <id> --page <id> --ai DeepSeek --name <task> [--scope page|file]
  node adapters/dsh-bridge.mjs heartbeat --client <id> --binding <id>
  node adapters/dsh-bridge.mjs release --client <id> --binding <id>
  node adapters/dsh-bridge.mjs document [--connection <id>]
  node adapters/dsh-bridge.mjs pages [--connection <id>]
  node adapters/dsh-bridge.mjs node <nodeId> [--depth 0-50] [--connection <id>]
  node adapters/dsh-bridge.mjs export <nodeId> [--format png|svg] [--scale 0.1-4] [--out <file>] [--connection <id>]
  node adapters/dsh-bridge.mjs command '<json>' [--connection <id>]
  node adapters/dsh-bridge.mjs command @command.json
  node adapters/dsh-bridge.mjs operation <requestId> --client <id> --connection <id>
  node adapters/dsh-bridge.mjs validate-layout <nodeId> --binding <id> --client <id> [--out <report.json>]
  node adapters/dsh-bridge.mjs undo <operationId> --binding <id> --client <id> [--dry-run]

Environment:
  BRIDGE_PORT           default 37821
  BRIDGE_READ_TIMEOUT_MS
  BRIDGE_WRITE_TIMEOUT_MS
  FIGMA_CONNECTION_ID   default target when multiple files are connected
  FIGMA_CLIENT_ID       client returned by bind
  FIGMA_BINDING_ID      binding returned by bind (required for writes)
  FIGMA_BRIDGE_ROOT     override the bridge package directory

Safety:
  Reads and exports are safe by default. Writes are sent only through
  "command" and require explicit user authorization in the conversation.
  Writes require an explicit page binding. Client IDs are routing identities,
  not authentication secrets. Keep this local bridge on loopback.`);
}

function readFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function positional() {
  const values = [];
  const withValue = new Set(['--connection', '--depth', '--format', '--scale', '--out', '--client', '--binding', '--page', '--ai', '--name', '--scope','--profile']);
  for (let i = 1; i < args.length; i++) {
    const current = args[i];
    if (withValue.has(current)) { i++; continue; }
    if (current.startsWith('--')) continue;
    values.push(current);
  }
  return values;
}

function targetConnection() {
  return readFlag('--connection') || process.env.FIGMA_CONNECTION_ID || undefined;
}

function withConnection(command) {
  const connectionId = targetConnection();
  if (connectionId && command.connectionId === undefined) command.connectionId = connectionId;
  const bindingId = readFlag('--binding') || process.env.FIGMA_BINDING_ID;
  const clientId = readFlag('--client') || process.env.FIGMA_CLIENT_ID;
  if (bindingId && command.bindingId === undefined) command.bindingId = bindingId;
  if (clientId && command.clientId === undefined) command.clientId = clientId;
  return command;
}

async function controlPost(route, body) {
  const {state} = await ensureBridge();
  if (state.controllerProtocol !== 1) throw Error('Start bridge 0.4.0 before controlling pages.');
  const response = await fetch(baseUrl + route, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(10000)});
  const value = await response.json();
  if (!response.ok || !value.ok) throw Error(value.error || 'Controller request failed');
  return value;
}

async function health(timeout = 900) {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function validateHealth(state) {
  if (!state?.ok || state.serverName !== 'codex-local-bridge' || state.protocolVersion !== 2) {
    throw new Error(`The service on port ${port} is not a compatible codex-local-bridge v2 instance. Stop the conflicting process or set BRIDGE_PORT consistently in the server, plugin and adapter.`);
  }
  return state;
}

async function ensureBridge() {
 const discovery=await import(pathToFileURL(path.join(bridgeRoot,'bridge-discovery.mjs')));
 const options=discovery.optionsFromEnv({...process.env,...(readFlag('--profile')?{BRIDGE_PROFILE:readFlag('--profile')}:{})});
 const before=await discovery.discover(options),state=before||await discovery.ensureDiscovered(bridgeRoot,options);
 const version=discovery.compatibility(state);if(!version.compatible)throw Error(version.reasons.join('; '));baseUrl=state.endpoint;
 return {state:validateHealth(state),started:!before};
}

async function sendCommand(command) {
  const { state } = await ensureBridge();
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Command must be a JSON object.');
  if (!command.type) throw new Error('Command requires a "type" field.');
  const body = withConnection(command);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70000);
  try {
    const response = await fetch(`${baseUrl}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error(`Bridge returned non-JSON HTTP ${response.status}: ${text.slice(0, 240)}`); }
    if (!response.ok || !payload.ok) {
      let message = payload.error || `Bridge returned HTTP ${response.status}`;
      if (/No Figma connection|Multiple files connected|Target connection/.test(message)) {
        message = `${message.replace(/[.。!?]+$/, '')}. Check "status" and ask the user to open the Figma plugin in the target file.`;
      }
      const error = new Error(message);
      error.payload = payload;
      throw error;
    }
    return { result: payload.pending?payload:payload.result, bridge: state, connectionId: payload.connectionId };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The command timed out at the adapter. Do not blindly retry writes. Run "status" and inspect lastResult/progress before deciding.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function connect() {
  const { state, started } = await ensureBridge();
  let document = null;
  let error = null;
  try { document = (await sendCommand({ type: 'get-document-info' })).result; } catch (cause) { error = cause.message; }
  return {
    bridge: { running: true, url: baseUrl, startedByAdapter: started, serverVersion: state.serverVersion, figmaConnected: state.figmaConnected },
    connections: state.connections || [],
    document,
    manifestPath,
    setup: document
      ? 'Connected. A document response was read back successfully.'
      : `Bridge is running but Figma is not connected. In Figma Desktop: Plugins → Development → Codex Local Bridge (or import ${manifestPath}) and keep the plugin window open.`,
    error
  };
}

async function status() {
  const state = await health();
  if (!state) return { running: false, url: baseUrl, manifestPath };
  return {
    running: true,
    url: baseUrl,
    manifestPath,
    serverName: state.serverName,
    serverVersion: state.serverVersion,
    protocolVersion: state.protocolVersion,
    panelProtocol: state.panelProtocol,
    hub: state.hub,
    figmaConnected: state.figmaConnected,
    connections: state.connections || []
  };
}

function numberFlag(name, fallback) {
  const raw = readFlag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
}

async function main() {
  if (['help', '-h', '--help'].includes(commandName)) { printHelp(); return; }

  if(commandName==='operation'){
    const [requestId]=positional(),connectionId=targetConnection(),clientId=readFlag('--client')||process.env.FIGMA_CLIENT_ID;
    if(!requestId||!connectionId||!clientId)throw Error('operation needs requestId, --connection and --client');
    await ensureBridge();const response=await fetch(baseUrl+'/operations?'+new URLSearchParams({requestId,connectionId,clientId})),value=await response.json();if(!response.ok)throw Error(value.error);writeJson(value);return;
  }
  if(commandName==='undo'){
    const [operationId]=positional();if(!operationId)throw Error('undo requires operationId');
    const {result}=await sendCommand({type:'undo-operation',operationId,dryRun:args.includes('--dry-run')});writeJson(result);return;
  }
  if(commandName==='validate-layout'){
    const [nodeId]=positional();if(!nodeId)throw Error('validate-layout requires nodeId');
    const {result}=await sendCommand({type:'validate-layout',nodeId});const out=readFlag('--out');
    if(out){const reportPath=path.resolve(out);fs.mkdirSync(path.dirname(reportPath),{recursive:true});for(const [i,image] of result.screenshots.entries()){const imagePath=reportPath.replace(/\.json$/i,'')+'-'+i+'.png';fs.writeFileSync(imagePath,Buffer.from(image.base64,'base64'));delete image.base64;image.file=imagePath;}fs.writeFileSync(reportPath,JSON.stringify(result,null,2));writeJson({report:reportPath,summary:result.summary});}else writeJson(result);return;
  }
  if(commandName==='settings') {const {state}=await ensureBridge();writeJson({endpoint:state.endpoint,profile:state.profile,instanceId:state.instanceId,serviceVersion:state.serverVersion,newFileSupported:false,newPage:'command {type:design-system,action:page,name:...} with exclusive file binding'});return;}
  if(commandName==='review') {const [nodeId]=positional();if(!nodeId)throw Error('review requires nodeId');const {result}=await sendCommand({type:'review-layout',nodeId});const out=readFlag('--out');if(out){const reportPath=path.resolve(out);fs.mkdirSync(path.dirname(reportPath),{recursive:true});for(const [i,image] of result.screenshots.entries()){const file=reportPath+'.'+i+'.png';fs.writeFileSync(file,Buffer.from(image.base64,'base64'));delete image.base64;image.file=file;}fs.writeFileSync(reportPath,JSON.stringify(result,null,2));writeJson({reviewId:result.reviewId,report:reportPath,next:'Inspect PNG with host AI; command repair-layout using this receipt; repeat up to 3 rounds.'});}else writeJson(result);return;}
  if (commandName === 'bind') {
    const connectionId = targetConnection(), pageId = readFlag('--page'), name = readFlag('--name'), aiName = readFlag('--ai') || 'DeepSeek';
    if (!connectionId || !pageId || !name) throw Error('bind requires --connection, --page and --name.');
    const existingClient = readFlag('--client') || process.env.FIGMA_CLIENT_ID;
    const client = existingClient ? {clientId:existingClient} : await controlPost('/clients/register', {name,aiName});
    writeJson(await controlPost('/bindings', {clientId:client.clientId, connectionId, pageId, scope:readFlag('--scope') || 'page'}));
    return;
  }
  if (['heartbeat','release'].includes(commandName)) {
    const body = withConnection({});
    if (!body.bindingId || !body.clientId) throw Error('Provide --client and --binding, or FIGMA_CLIENT_ID and FIGMA_BINDING_ID.');
    writeJson(await controlPost('/bindings/' + commandName, body)); return;
  }

  if (commandName === 'status') {
    writeJson(await status());
    return;
  }

  if (commandName === 'start') {
    const { state, started } = await ensureBridge();
    writeJson({
      bridge: { running: true, url: baseUrl, startedByAdapter: started, serverVersion: state.serverVersion, protocolVersion: state.protocolVersion },
      figmaConnected: state.figmaConnected,
      connections: state.connections || [],
      manifestPath,
      next: state.figmaConnected
        ? 'Figma is connected. Try "document".'
        : `In Figma Desktop: Plugins → Development → Codex Local Bridge (or import ${manifestPath}), then keep the plugin window open.`
    });
    return;
  }

  if (commandName === 'connect') {
    writeJson(await connect());
    return;
  }

  if (commandName === 'document') {
    const { result } = await sendCommand({ type: 'get-document-info' });
    writeJson(result);
    return;
  }

  if (commandName === 'pages') {
    const { result } = await sendCommand({ type: 'get-pages' });
    writeJson(result);
    return;
  }

  if (commandName === 'node') {
    const [nodeId] = positional();
    if (!nodeId) throw new Error('Usage: node adapters/dsh-bridge.mjs node <nodeId> [--depth 0-50]');
    const depth = numberFlag('--depth', 20);
    if (!Number.isInteger(depth) || depth < 0 || depth > 50) throw new Error('--depth must be an integer between 0 and 50.');
    const { result } = await sendCommand({ type: 'get-node', nodeId, depth });
    writeJson(result);
    return;
  }

  if (commandName === 'export') {
    const [nodeId] = positional();
    if (!nodeId) throw new Error('Usage: node adapters/dsh-bridge.mjs export <nodeId> [--format png|svg] [--scale 0.1-4] [--out <file>]');
    let format = String(readFlag('--format') || 'png').toLowerCase();
    if (!['png', 'svg'].includes(format)) throw new Error('--format must be png or svg.');
    const scale = numberFlag('--scale', 1);
    if (scale < 0.1 || scale > 4) throw new Error('--scale must be between 0.1 and 4.');
    const out = path.resolve(readFlag('--out') || `figma-export-${nodeId.replace(/[^a-zA-Z0-9._-]/g, '_')}.${format}`);
    const { result } = await sendCommand({ type: 'export-node', nodeId, format: format.toUpperCase(), scale });
    if (!result?.base64) throw new Error('Bridge returned no export data.');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const bytes = Buffer.from(result.base64, 'base64');
    fs.writeFileSync(out, bytes);
    writeJson({ nodeId: result.nodeId, name: result.name, format: result.format, file: out, bytes: bytes.length });
    return;
  }

  if (commandName === 'command') {
    const rawArg = args[1];
    if (!rawArg) throw new Error('Usage: node adapters/dsh-bridge.mjs command \'<json>\'');
    const raw = rawArg.startsWith('@') ? fs.readFileSync(path.resolve(rawArg.slice(1)), 'utf8') : rawArg;
    let command;
    try { command = JSON.parse(raw); } catch (error) { throw new Error(`Invalid JSON command: ${error.message}`); }
    const { result } = await sendCommand(command);
    writeJson(result);
    return;
  }

  throw new Error(`Unknown command: ${commandName}. Run with --help.`);
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  if(error.payload)process.stderr.write('DETAILS: '+JSON.stringify(error.payload)+'\n');
  if (error.payload?.progress) process.stderr.write(`PROGRESS: ${JSON.stringify(error.payload.progress)}\n`);
  process.exitCode = 1;
});
