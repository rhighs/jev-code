import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { EntryType, Question, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { runDecide } from '../src/decide.js';
import { MAX_GRID_REQUEST_BYTES } from '../src/scored-grid.js';
import type { DecisionProvider, HarnessEvent } from '../src/types.js';

type Answer = (state: Record<string, unknown>, question: Question) => unknown;
const fake = (answer: Answer, states: Record<string, unknown>[] = []): DecisionProvider => ({
  decide: async <Q extends Questions>(state: EntryType, questions: Q) => {
    states.push(state as Record<string, unknown>);
    return { model: 'fake', usage: { input_tokens: 1, output_tokens: 0 },
      answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, answer(state as Record<string, unknown>, q)])) } as unknown as SystemOneResult<Q>;
  },
});
const pick = (choice: string, confidence = 0.93): Answer => (_state, q) => {
  if (q.type !== 'choice') throw new Error(`unexpected ${q.type}`);
  const labels = Object.keys(q.criteria);
  return { type: 'choice', choice, confidence, probabilities: Object.fromEntries(labels.map(l => [l, l === choice ? confidence : Number(((1 - confidence) / (labels.length - 1)).toFixed(4))])) };
};
const verdict = (fn: (input: string) => number): Answer => (state, q) => {
  if (q.type !== 'noul') throw new Error(`unexpected ${q.type}`);
  return { type: 'noul', noul: fn(String(state.input)) };
};
const rate = (fn: (input: string) => Record<string, number>): Answer => (state, q) => {
  if (q.type !== 'score') throw new Error(`unexpected ${q.type}`);
  const probabilities = fn(String(state.input));
  const score = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: 'score', score: Number(score), confidence: 0.8,
    legend: Object.fromEntries(q.criteria.map((description, index) => [String(index), description])), probabilities };
};
const spec = async (t: test.TestContext, entries: unknown): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-decide-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'spec.json');
  await writeFile(path, JSON.stringify(entries));
  return path;
};

test('choice prints the label with its confidence and exits with the chosen index', async () => {
  const yes = await runDecide(['Is this an error?', '--choices', 'yes,no'], 'Traceback (most recent call last)', fake(pick('yes')));
  assert.deepEqual(yes, { stdout: 'yes 0.93\n', stderr: '', code: 0 });
  const no = await runDecide(['Is this an error?', '--choices', 'yes,no'], 'all good', fake(pick('no', 0.6)));
  assert.equal(no.stdout, 'no 0.60\n');
  assert.equal(no.code, 1);
});

test('choice sends the stdin text and the labels as criteria', async () => {
  const states: Record<string, unknown>[] = [];
  const provider = fake((state, q) => { assert.equal(q.type, 'choice'); assert.deepEqual(Object.keys((q as { criteria: object }).criteria), ['a', 'b', 'c']); return pick('b')(state, q); }, states);
  const res = await runDecide(['pick', '--choices', 'a, b ,c'], 'text', provider);
  assert.equal(res.code, 1);
  assert.equal(states[0]!.input, 'text');
});

test('--true prints the probability and exits by the threshold', async () => {
  const pass = await runDecide(['--true', 'The input is an error'], 'Traceback', fake(verdict(() => 0.91)));
  assert.deepEqual(pass, { stdout: '0.91\n', stderr: '', code: 0 });
  const fail = await runDecide(['--true', 'The input is an error', '--threshold', '0.95'], 'Traceback', fake(verdict(() => 0.91)));
  assert.equal(fail.stdout, '0.91\n');
  assert.equal(fail.code, 1);
  const low = await runDecide(['--true', 'The input is an error'], 'ok', fake(verdict(() => 0.2)));
  assert.equal(low.code, 1);
});

test('--score prints the expected level with its label and exits 0', async () => {
  const res = await runDecide(['--score', 'relevance to the task'], 'text', fake(rate(() => ({ '0': 0, '1': 0, '2': 0.5, '3': 0.5 }))));
  assert.deepEqual(res, { stdout: '2.50 fully satisfies\n', stderr: '', code: 0 });
  const mid = await runDecide(['--score', 'relevance to the task'], 'text', fake(rate(() => ({ '0': 0, '1': 1, '2': 0, '3': 0 }))));
  assert.equal(mid.stdout, '1.00 partially satisfies\n');
});

test('--score --lines ranks the lines by expected score, best first', async () => {
  const levels = (input: string): Record<string, number> => ({ '0': input === 'a' ? 1 : 0, '1': input === 'bb' ? 1 : 0, '2': 0, '3': input === 'ccc' ? 1 : 0 });
  const res = await runDecide(['--score', 'relevance', '--lines'], 'a\nccc\nbb\n', fake(rate(levels)));
  assert.deepEqual(res, { stdout: '3.00\tccc\n1.00\tbb\n0.00\ta\n', stderr: '', code: 0 });
});

test('--true --lines ranks by probability and --threshold keeps only lines at or above it', async () => {
  const p = (input: string): number => ({ low: 0.1, mid: 0.5, high: 0.9 })[input] ?? 0;
  const all = await runDecide(['--true', 'relevant', '--lines'], 'low\nhigh\nmid\n', fake(verdict(p)));
  assert.equal(all.stdout, '0.90\thigh\n0.50\tmid\n0.10\tlow\n');
  const kept = await runDecide(['--true', 'relevant', '--lines', '--threshold', '0.5'], 'low\nhigh\nmid\n', fake(verdict(p)));
  assert.deepEqual(kept, { stdout: '0.90\thigh\n0.50\tmid\n', stderr: '', code: 0 });
});

test('--spec runs every question over the same stdin and prints one JSON line each', async t => {
  const path = await spec(t, [{ question: 'Is this an error?', choices: ['yes', 'no'] }, { true: 'The input mentions Python' }, { score: 'severity' }]);
  const answer: Answer = (state, q) => q.type === 'choice' ? pick('yes')(state, q) : q.type === 'noul' ? verdict(() => 0.75)(state, q) : rate(() => ({ '0': 0, '1': 0, '2': 1, '3': 0 }))(state, q);
  const res = await runDecide(['--spec', path], 'Traceback', fake(answer));
  assert.equal(res.code, 0);
  const lines = res.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines.length, 3);
  assert.equal(lines[0]!.question, 'Is this an error?');
  assert.equal(lines[0]!.choice, 'yes');
  assert.equal(lines[0]!.confidence, 0.93);
  assert.deepEqual(lines[0]!.options, [{ label: 'yes', probability: 0.93 }, { label: 'no', probability: 0.07 }]);
  assert.deepEqual(lines[1], { question: 'The input mentions Python', probability: 0.75 });
  assert.equal(lines[2]!.question, 'severity');
  assert.equal(lines[2]!.score, 2);
});

test('--json prints the answer as a decision event over the stdin field', async () => {
  const res = await runDecide(['Is this an error?', '--choices', 'yes,no', '--json'], 'Traceback', fake(pick('yes')));
  assert.equal(res.code, 0);
  const event = JSON.parse(res.stdout) as HarnessEvent;
  assert.equal(event.type, 'decision');
  assert.equal(event.turn, 0);
  assert.match(event.runId, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(event.timestamp)));
  assert.equal(typeof event.elapsedMs, 'number');
  if (event.type !== 'decision') return;
  assert.equal(event.data.choice, 'yes');
  assert.equal(event.data.confidence, 0.93);
  assert.equal(event.data.field, 'stdin');
  assert.equal(event.data.model, 'fake');
  assert.deepEqual(event.data.options, [{ label: 'yes', probability: 0.93 }, { label: 'no', probability: 0.07 }]);
  const truth = await runDecide(['--true', 'error', '--json'], 'Traceback', fake(verdict(() => 0.91)));
  const verdictEvent = JSON.parse(truth.stdout) as HarnessEvent;
  assert.equal(verdictEvent.type, 'decision');
  if (verdictEvent.type === 'decision') assert.equal(verdictEvent.data.probability, 0.91);
});

test('bad arguments exit 125 with a reason', async () => {
  const provider = fake(pick('a'));
  for (const argv of [
    ['q', '--choices', 'only'],
    ['q', '--choices', Array.from({ length: 101 }, (_, i) => `c${i}`).join(',')],
    ['q'],
    [],
    ['--true', 'x', '--score', 'y'],
    ['q', '--choices', 'a,b', '--lines'],
    ['--true', 'x', '--threshold', '2'],
    ['--true', 'x', '--bogus'],
  ]) {
    const res = await runDecide(argv, 'text', provider);
    assert.equal(res.code, 125, argv.join(' '));
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /\S/);
  }
  const hundred = await runDecide(['q', '--choices', Array.from({ length: 100 }, (_, i) => `c${i}`).join(',')], 'text', fake(pick('c99')));
  assert.equal(hundred.code, 99);
});

test('a provider decision failure exits 125 and names the reason', async () => {
  const broken = fake(() => ({ type: 'choice', choice: 'maybe', confidence: 1, probabilities: { maybe: 1 } }));
  const res = await runDecide(['q', '--choices', 'yes,no'], 'text', broken);
  assert.equal(res.code, 125);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /unavailable choice/);
  const down: DecisionProvider = { decide: async () => { throw new Error('connection refused'); } };
  const failed = await runDecide(['q', '--choices', 'yes,no'], 'text', down);
  assert.equal(failed.code, 125);
  assert.match(failed.stderr, /connection refused/);
});

test('oversized stdin fails with 125 unless --truncate allows deciding on the head', async () => {
  const refused = await runDecide(['q', '--choices', 'yes,no'], 'x'.repeat(MAX_GRID_REQUEST_BYTES * 2), fake(pick('yes')));
  assert.equal(refused.code, 125);
  assert.match(refused.stderr, /Pass --truncate/);
  const states: Record<string, unknown>[] = [];
  const res = await runDecide(['q', '--choices', 'yes,no', '--truncate'], 'x'.repeat(MAX_GRID_REQUEST_BYTES * 2), fake(pick('yes'), states));
  assert.equal(res.code, 0);
  assert.match(res.stderr, /^input truncated to \d+ bytes\n$/);
  const sent = String(states[0]!.input);
  assert.ok(sent.length < MAX_GRID_REQUEST_BYTES);
  assert.equal(res.stderr, `input truncated to ${Buffer.byteLength(sent)} bytes\n`);
});

test('cli decide without TYPESAFE_API_KEY exits 125 with a message', async t => {
  const run = promisify(execFile);
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  env.JEV_CODE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'jev-cfg-'));
  const cwd = await mkdtemp(join(tmpdir(), 'jev-decide-'));
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); await rm(env.JEV_CODE_CONFIG_DIR!, { recursive: true, force: true }); });
  await assert.rejects(run(resolve('node_modules/.bin/tsx'), [resolve('src/cli.ts'), 'decide', 'Is this an error?', '--choices', 'yes,no'], { cwd, env, timeout: 60_000 }),
    (err: Error & { code?: unknown; stderr?: string }) => err.code === 125 && /jev-code login.*TYPESAFE_API_KEY/.test(err.stderr ?? ''));
});

test('--json --lines keeps the event shape and carries the line inside data', async () => {
  const res = await runDecide(['--score', 'clear', '--lines', '--json'], 'alpha\nbeta\n', fake(rate(() => ({ '0': 0, '1': 0, '2': 1, '3': 0 }))));
  const events = res.stdout.trim().split('\n').map(line => JSON.parse(line) as HarnessEvent);
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['data', 'elapsedMs', 'runId', 'timestamp', 'turn', 'type']);
    if (event.type === 'decision') assert.match(String(event.data.line), /^(alpha|beta)$/);
  }
});

test('--spec choices may contain commas', async t => {
  const res = await runDecide(['--spec', await spec(t, [{ question: 'Which?', choices: ['a, b', 'c'] }])], 'text', fake(pick('a, b')));
  assert.equal(res.code, 0);
  assert.equal((JSON.parse(res.stdout) as { choice: string }).choice, 'a, b');
});
