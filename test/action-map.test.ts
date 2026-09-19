import assert from 'node:assert/strict';
import test from 'node:test';
import { parseActions, recoverAction, stalled } from '../src/action-map.js';
import { Decisions } from '../src/decisions.js';
import { builtInTools } from '../src/tools.js';
import type { ToolRecord } from '../src/types.js';
import { SlotProvider } from './helpers.js';

const tools = builtInTools();
const read: ToolRecord = { turn: 1, tool: 'read_file', args: { path: 'fib.py', offset: 0, limit: 8000 }, result: { ok: true, output: 'existing function' } };
const run: ToolRecord = { turn: 2, tool: 'bash', args: { command: 'python3 test_fib.py', cwd: '.', timeout_ms: 30_000 }, result: { ok: true, output: '3 tests OK' } };
const write: ToolRecord = { turn: 3, tool: 'write_file', args: { path: 'fib.py', content: 'changed' }, result: { ok: true, output: 'wrote' } };

test('recovery detects repeated read/run cycles and resets after a successful write', () => {
  assert.equal(stalled([read, run, read], tools), true);
  assert.equal(stalled([read, read, run, read], tools), true);
  assert.equal(stalled([read, run], tools), false);
  assert.equal(stalled([read, run, write, read], tools), false);
  assert.equal(stalled([read, { ...read, result: { ok: true, output: 'changed' } }], tools), false);
});

test('recovery filters unknown tools, invalid arguments, code, and equivalent repeated calls', () => {
  const rows: unknown[] = [
    { tool: 'read_file', objective: 'Repeat', args: { limit: 8000, offset: 0, path: './fib.py' } },
    { tool: 'read_file', objective: 'Inspect the missing test', args: { path: 'test_fib.py' } },
    { tool: 'write_file', objective: 'Bypass mapping', args: { path: 'fib.py', content: 'bad' } },
    { tool: 'bash', objective: 'Unbounded call', args: { command: 'echo x', timeout_ms: -1 } },
    { tool: 'unknown', objective: 'Unknown', args: {} },
    { tool: 'read_file', objective: 'Unknown field', args: { path: 'test_fib.py', constructor: 1 } },
  ];
  assert.deepEqual(parseActions(JSON.stringify(rows.slice(0, 4)), tools, [read]), [
    { tool: 'read_file', objective: 'Inspect the missing test', args: { path: 'test_fib.py', offset: 0, limit: 8000 } },
  ]);
  assert.deepEqual(parseActions(JSON.stringify(rows.slice(4)), tools, []), []);
});

test('only Jev can select a recovery action and the call consumes the shared budget', async () => {
  const budget = { used: 0, max: 1 };
  const provider = { id: 'mapper', model: 'small', generate: async () => [{ text: JSON.stringify([{ tool: 'read_file', objective: 'Inspect missing negative-input coverage', args: { path: 'test_fib.py' } }]), truncated: false }] };
  const state = { task: { prompt: 'Add a negative-input test.' }, recent: [read, run] };
  const d = new Decisions(new SlotProvider([{ slot: 'recover', answer: 'reject' }]), 5, new AbortController().signal);
  assert.equal(await recoverAction({ provider, budget }, d, state, tools, [read, run, read]), undefined);
  assert.equal(budget.used, 1);
  assert.equal(d.requests, 1);
  assert.equal(await recoverAction({ provider, budget }, d, state, tools, [read]), undefined);
  assert.equal(d.requests, 1);
});
