import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./figma/runtime-reliability.js', import.meta.url), 'utf8');
const context = vm.createContext({
  API_CONTRACT: {nodeProperties: []},
  commandPage: async () => context.fixture,
});
vm.runInContext(source.slice(0, source.indexOf('async function restoreState')), context);
assert.equal(vm.runInContext('SNAPSHOT_LIMIT', context), 48 * 1024 * 1024);
vm.runInContext('nodeSnapshot = n => ({id:n.id,payload:n.payload})', context);

// Exercise the actual serializer's limit check without modifying a Figma document.
context.fixture = {id: 'within-limit', payload: 'x'.repeat(16 * 1024 * 1024), children: []};
const accepted = await vm.runInContext('captureState({})', context);
assert.equal(accepted.nodes.length, 1, 'A snapshot above the former 24 MiB limit must succeed');
context.fixture = {id: 'over-limit', payload: 'x'.repeat(25 * 1024 * 1024), children: []};
await assert.rejects(vm.runInContext('captureState({})', context), /Snapshot exceeds 48 MiB/);
console.log('PASS snapshot limit: accepts approximately 32 MiB and rejects approximately 50 MiB');
