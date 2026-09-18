import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Harness } from '../src/harness.js';
import type { HarnessEvent } from '../src/types.js';
import { ScriptedProvider } from './helpers.js';

const FIXTURE = new URL('./fixtures/events-baseline.jsonl', import.meta.url);
const ADDED = new Set(['schema', 'options', 'field', 'phase', 'slot', 'unit', 'candidate']);

const mask = (event: HarnessEvent, ws: string): Record<string, unknown> => {
  const val = JSON.parse(JSON.stringify(event).replaceAll(ws, '<ws>')) as Record<string, unknown>;
  val.runId = '<run>'; val.timestamp = '<ts>'; val.elapsedMs = 0;
  const data = val.data as Record<string, unknown>;
  for (const k of ['durationMs', 'elapsedMs', 'startedAt', 'endedAt']) if (k in data) data[k] = 0;
  return val;
};

const strip = (val: unknown): unknown => {
  if (Array.isArray(val)) return val.map(strip);
  if (val && typeof val === 'object') return Object.fromEntries(Object.entries(val).filter(([k]) => !ADDED.has(k)).map(([k, v]) => [k, strip(v)]));
  return val;
};

/** Regenerate with UPDATE_FIXTURES=1 npm test -- test/events-baseline.test.ts */
test('--json events only gain fields relative to the recorded baseline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-baseline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = await realpath(root);
  const events: HarnessEvent[] = [];
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'hello.txt', content: 'hello\n' } },
    { action: 'bash', args: { command: 'cat hello.txt', cwd: '.', timeout_ms: '' } },
    { action: 'finish', verdict: 1 },
  ]);
  const result = await new Harness({ workspace: ws, provider, experimentalGrid: true, journalDirectory: false, onEvent: e => { events.push(e); } }).run('Write hello into hello.txt and print it.');
  assert.equal(result.status, 'completed', result.summary);
  const lines = events.map(e => JSON.stringify(mask(e, ws)));
  if (process.env.UPDATE_FIXTURES) { await writeFile(FIXTURE, lines.join('\n') + '\n'); return; }
  const baseline = (await readFile(FIXTURE, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown);
  assert.deepEqual(lines.map(line => strip(JSON.parse(line))), baseline.map(strip));
});
