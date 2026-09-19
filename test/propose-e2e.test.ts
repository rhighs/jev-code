import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AstRegistry } from '../src/ast-adapters.js';
import { writeConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { writeCredential } from '../src/providers/credentials.js';
import { proposeTools } from '../src/providers/index.js';
import { builtInTools } from '../src/tools.js';
import { initialState, reduce } from '../src/transcript.js';
import type { HarnessEvent, RunResult } from '../src/types.js';
import { ScriptedProvider, type Step } from './helpers.js';

const KEY = 'sk-secret-123';
const TAIL = '\n\nimport os\nprint(f(), os.environ.get("JEV_GENERATION_API_KEY", "absent"))\n';
const CANDIDATES = [`def f():\n    return 1${TAIL}`, 'def f(:\n', `def f():\n    return 2${TAIL}`];
const PROMPT = 'Make f return 2 in calc.py and run it.';

interface Recorded { url: string; headers: IncomingHttpHeaders; body: string }
interface Mock { baseUrl: string; reqs: Recorded[] }
interface Run { result: RunResult; events: HarnessEvent[]; journal: string; stderr: string; root: string; reqs: Recorded[] }
interface Opts { failAt?: number; envKey?: boolean }

const tmp = async (t: test.TestContext, prefix: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const serve = async (t: test.TestContext, failAt?: number): Promise<Mock> => {
  const reqs: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const idx = reqs.length;
      reqs.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (!(req.url ?? '').endsWith('/chat/completions')) return json(res, 404, { error: 'not found' });
      if (idx === failAt) return json(res, 500, { error: 'boom', headers: req.headers });
      json(res, 200, { choices: [{ message: { content: CANDIDATES[idx] ?? '' }, finish_reason: 'stop' }] });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { baseUrl: `http://127.0.0.1:${port}/v1`, reqs };
};

const step = (candidate: string): Step => ({ action: 'propose', args: { kind: 'file', path: 'calc.py', objective: 'add function f returning 2', constraints: '', count: '3' }, candidate });
const bash: Step = { action: 'bash', args: { command: 'python3 calc.py', cwd: '.', timeout_ms: '' } };
const finish: Step = { action: 'finish', verdict: 1 };

const run = async (t: test.TestContext, steps: Step[], opts: Opts = {}): Promise<Run> => {
  const mock = await serve(t, opts.failAt);
  const root = await tmp(t, 'jev-e2e-ws-');
  const journals = await tmp(t, 'jev-e2e-journal-');
  const env: NodeJS.ProcessEnv = { JEV_CODE_CONFIG_DIR: join(await tmp(t, 'jev-e2e-cfg-'), 'cfg') };
  await writeConfig({ generation: { provider: 'openai-compatible', model: 'tiny', auth: 'api_key', baseUrl: mock.baseUrl } }, env);
  if (opts.envKey) {
    env.JEV_GENERATION_API_KEY = KEY;
    process.env.JEV_GENERATION_API_KEY = KEY;
    t.after(() => { delete process.env.JEV_GENERATION_API_KEY; });
  } else await writeCredential('openai-compatible', { type: 'api_key', key: KEY }, env);
  const errs: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { errs.push(String(chunk)); return true; }) as typeof process.stderr.write;
  t.after(() => { process.stderr.write = orig; });
  const tools = [...builtInTools(), ...await proposeTools(env, new AstRegistry(), line => errs.push(line))];
  const events: HarnessEvent[] = [];
  const provider = new ScriptedProvider(steps);
  const result = await new Harness({ workspace: root, provider, tools, journalDirectory: journals, onEvent: e => { events.push(e); }, bundledAsts: true, maxTurns: 6 }).run(PROMPT);
  const journal = await readFile(join(journals, `${result.id}.jsonl`), 'utf8');
  return { result, events, journal, stderr: errs.join(''), root, reqs: mock.reqs };
};

const proposeEnd = (events: HarnessEvent[]): Extract<HarnessEvent, { type: 'tool_end' }> => {
  const end = events.find(e => e.type === 'tool_end' && e.data.tool === 'propose');
  assert.ok(end && end.type === 'tool_end');
  return end;
};

const noLeak = (r: Run): void => {
  assert.equal(r.reqs.length, 3);
  assert.ok(r.reqs.every(req => req.headers.authorization === `Bearer ${KEY}`));
  assert.ok(!JSON.stringify(r.events).includes(KEY), 'events leak the key');
  assert.ok(!r.journal.includes(KEY), 'journal leaks the key');
  assert.ok(!r.stderr.includes(KEY), 'stderr leaks the key');
  assert.ok(!r.result.summary.includes(KEY), 'summary leaks the key');
};

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

test('AE1: propose selects C, writes calc.py, the next bash sees the new content, and the replay renders a diff card', async t => {
  const r = await run(t, [step('C'), bash, finish]);
  assert.equal(r.result.status, 'completed', r.result.summary);
  assert.match(await readFile(join(r.root, 'calc.py'), 'utf8'), /return 2/);
  const end = proposeEnd(r.events);
  assert.equal(end.data.result.ok, true);
  assert.equal(end.data.result.data?.selected, 'C');
  const summaries = end.data.result.data?.candidates as Array<{ label: string; valid: boolean }>;
  assert.deepEqual(summaries.map(c => [c.label, c.valid]), [['A', true], ['B', false], ['C', true]]);
  assert.ok(r.events.some(e => e.type === 'decision' && e.data.field === 'candidate' && e.data.choice === 'C'));
  const ran = r.result.records.find(rec => rec.tool === 'bash');
  assert.ok(ran?.result.ok, ran?.result.output);
  assert.ok(ran.result.output.startsWith('2'), ran.result.output);
  const replay = r.events.reduce(reduce, initialState());
  const card = replay.items.find(item => item.kind === 'tool' && item.tool === 'propose');
  assert.ok(card && card.kind === 'tool');
  assert.equal(card.body?.kind, 'diff');
  noLeak(r);
});

test('AE2: rejecting every candidate writes nothing and the run carries on', async t => {
  const r = await run(t, [step('reject'), finish]);
  assert.notEqual(r.result.status, 'error', r.result.summary);
  assert.equal(r.result.status, 'completed', r.result.summary);
  assert.equal(await exists(join(r.root, 'calc.py')), false);
  const end = proposeEnd(r.events);
  assert.equal(end.data.result.ok, false);
  assert.match(end.data.result.output, /rejected all/);
  assert.equal(r.result.turns, 2);
});

test('AE3: a 500 that echoes the request headers fails one candidate and never surfaces the key', async t => {
  const r = await run(t, [step('C'), finish], { failAt: 1 });
  assert.notEqual(r.result.status, 'error', r.result.summary);
  const end = proposeEnd(r.events);
  assert.equal(end.data.result.ok, true);
  assert.match(end.data.result.output, /B invalid: generation failed: .*500/);
  assert.match(end.data.result.output, /selected C/);
  noLeak(r);
});

test('AE3: a key from JEV_GENERATION_API_KEY reaches the provider but not the events, journal, stderr or the bash child', async t => {
  const r = await run(t, [step('C'), bash, finish], { envKey: true });
  assert.equal(r.result.status, 'completed', r.result.summary);
  assert.equal(proposeEnd(r.events).data.result.data?.selected, 'C');
  const ran = r.result.records.find(rec => rec.tool === 'bash');
  assert.ok(ran?.result.ok, ran?.result.output);
  assert.equal(ran.result.output.trim(), '2 absent');
  noLeak(r);
});
