import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Harness } from '../src/harness.js';
import { printRun } from '../src/print.js';
import type { HarnessEvent } from '../src/types.js';
import { ScriptedProvider } from './helpers.js';

const FIXTURE = new URL('./fixtures/events-baseline.jsonl', import.meta.url);
const ADDED: Record<string, string[]> = { start: ['schema'], decision: ['options', 'field', 'phase', 'slot', 'unit', 'candidate', 'line'] };

const mask = (event: HarnessEvent, ws: string): Record<string, unknown> => {
  const val = JSON.parse(JSON.stringify(event).replaceAll(ws, '<ws>')) as Record<string, unknown>;
  val.runId = '<run>'; val.timestamp = '<ts>'; val.elapsedMs = 0;
  const data = val.data as Record<string, unknown>;
  for (const k of ['durationMs', 'elapsedMs', 'startedAt', 'endedAt']) if (k in data) data[k] = 0;
  return val;
};

const strip = (event: Record<string, unknown>): Record<string, unknown> => {
  const added = ADDED[String(event.type)] ?? [];
  const data = Object.fromEntries(Object.entries(event.data as Record<string, unknown>).filter(([k]) => !added.includes(k)));
  return { ...event, data };
};

const PROMPT = 'Write hello into hello.txt and print it.';
const script = (): ScriptedProvider => new ScriptedProvider([
  { action: 'write_file', args: { path: 'hello.txt', content: 'hello\n' } },
  { action: 'bash', args: { command: 'cat hello.txt', cwd: '.', timeout_ms: '' } },
  { action: 'finish', verdict: 1 },
]);

const workspace = async (t: test.TestContext): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'jev-baseline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
};

const compare = async (events: HarnessEvent[], ws: string): Promise<void> => {
  const baseline = (await readFile(FIXTURE, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown);
  assert.deepEqual(events.map(e => strip(mask(e, ws))), baseline);
};

/** Regenerate with UPDATE_FIXTURES=1 pnpm test -- test/events-baseline.test.ts */
test('--json events only gain fields relative to the recorded baseline', async t => {
  const ws = await workspace(t);
  const events: HarnessEvent[] = [];
  const result = await new Harness({ workspace: ws, provider: script(), experimentalGrid: true, journalDirectory: false, onEvent: e => { events.push(e); } }).run(PROMPT);
  assert.equal(result.status, 'completed', result.summary);
  if (process.env.UPDATE_FIXTURES) { await writeFile(FIXTURE, events.map(e => JSON.stringify(strip(mask(e, ws)))).join('\n') + '\n'); return; }
  await compare(events, ws);
  const text = events.find(e => e.type === 'text')!;
  const { field: _field, ...without } = text.data;
  const broken = events.map(e => e === text ? { ...e, data: without } as unknown as HarnessEvent : e);
  await assert.rejects(compare(broken, ws));
});

test('the --print path with --json emits the same one-event-per-line stream on stdout and nothing else', async t => {
  const ws = await workspace(t);
  const stdout = new PassThrough(), stderr = new PassThrough();
  let out = '', err = '';
  stdout.on('data', d => { out += String(d); });
  stderr.on('data', d => { err += String(d); });
  const result = await printRun({ harness: { workspace: ws, provider: script(), experimentalGrid: true, journalDirectory: false }, prompt: PROMPT,
    stdin: new PassThrough(), stdout, stderr, yes: true, confirmWrites: false, json: true, signal: new AbortController().signal });
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(err, '');
  assert.match(out, /\n$/);
  await compare(out.trim().split('\n').map(line => JSON.parse(line) as HarnessEvent), ws);
});
