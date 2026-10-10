import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { buildDecisionContext, windowSource, PENDING, COMPLETION_COMPACTION, DECISION_COMPACTION, decisionChoiceBytes, decisionProbabilityBytes, fitDecisionState, MAX_DECISION_REQUEST_BYTES } from '../src/decision-context.js';
import { Decisions } from '../src/decisions.js';
import { generatePythonAst } from '../src/python-ast.js';
import { MAX_GRID_REQUEST_BYTES } from '../src/scored-grid.js';
import type { DecisionProvider } from '../src/types.js';

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const source = ['import math', ...Array.from({ length: 80 }, (_, i) => `print(${i})`), `print(${PENDING})`, ...Array.from({ length: 80 }, (_, i) => `print(${i + 100})`)].join('\n') + '\n';
const parts = () => [
  { key: 'task', value: { prompt: 'x'.repeat(200) }, required: true },
  { key: 'core', value: { slot: 'argument_0', symbols: ['print'] }, required: true },
  { key: 'source', value: source, shrink: windowSource },
  { key: 'recent', value: [{ tool: 'bash', output: 'y'.repeat(400) }] },
  { key: 'plan', value: 'z'.repeat(300) },
];

test('parts that fit are returned unchanged with nothing trimmed', () => {
  const result = buildDecisionContext(parts(), bytes, 100_000);
  assert.deepEqual(result.trimmed, []);
  assert.deepEqual(Object.keys(result.values), ['task', 'core', 'source', 'recent', 'plan']);
  assert.equal(result.values.source, source);
});

test('over the cap, plan drops first, then recent, then source is windowed; task and core never drop', () => {
  const full = bytes(Object.fromEntries(parts().map(part => [part.key, part.value])));
  const noPlan = buildDecisionContext(parts(), bytes, full - 100);
  assert.deepEqual(noPlan.trimmed, ['plan']);
  assert.ok(!Object.hasOwn(noPlan.values, 'plan') && Object.hasOwn(noPlan.values, 'recent'));
  const noRecent = buildDecisionContext(parts(), bytes, full - 500);
  assert.deepEqual(noRecent.trimmed, ['plan', 'recent']);
  assert.equal(noRecent.values.source, source);
  const windowed = buildDecisionContext(parts(), bytes, 1200);
  assert.deepEqual(windowed.trimmed, ['plan', 'recent', 'source']);
  const text = windowed.values.source as string;
  assert.ok(text.length < source.length);
  assert.ok(text.includes(PENDING) && text.startsWith('import math\n'));
  assert.deepEqual(windowed.values.task, { prompt: 'x'.repeat(200) });
  assert.equal((windowed.values.core as { slot: string }).slot, 'argument_0');
  const tiny = buildDecisionContext(parts(), bytes, 10);
  assert.ok(Object.hasOwn(tiny.values, 'task') && Object.hasOwn(tiny.values, 'core') && Object.hasOwn(tiny.values, 'source'));
});

test('source windows shrink around the pending marker and keep the header', () => {
  const wide = windowSource(source, 1)!;
  const narrow = windowSource(source, 4)!;
  assert.ok(wide.length > narrow.length);
  assert.ok(narrow.includes(`print(${PENDING})`) && narrow.startsWith('import math\n'));
  assert.equal(windowSource('print(1)\n', 1), 'print(1)\n');
  assert.equal(windowSource(narrow, 99), undefined);
});

class LongProvider implements DecisionProvider {
  requests: number[] = [];
  constructor(private script: Array<string | { value: string }>) {}
  async decide<Q extends Questions>(input: EntryType, questions: Q): Promise<SystemOneResult<Q>> {
    this.requests.push(bytes({ state: input, questions }));
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(questions)) {
      const desired = this.script.shift();
      assert.notEqual(desired, undefined);
      assert.equal(question.type, 'choice');
      if (question.type !== 'choice') throw new Error('Expected Choice');
      const selection = typeof desired === 'string' ? desired : Object.entries(question.criteria).find(([, label]) => label === desired!.value)?.[0];
      assert.ok(selection, `Unavailable ${JSON.stringify(desired)}`);
      answers[key] = { type: 'choice', choice: selection, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selection)])) };
    }
    return { model: 'fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers } as unknown as SystemOneResult<Q>;
  }
}

test('a long partial program keeps every decision request under the cap and generation continues', async () => {
  const literal = 'lorem ipsum '.repeat(45).trim();
  const blocks = 3, per = 13, lines = blocks * (per + 1);
  // A two-argument print batches its sibling productions into one wave: the two 'string'
  // productions are answered by one request before the per-argument terminals.
  const chunk = (b: number): Array<string | { value: string }> => ['if', 'boolean', b % 2 ? 'false' : 'true', ...Array.from({ length: per }, (_, i) => ['expr', 'call', { value: 'print' }, ...(i % 2 ? ['2', 'string', 'string', { value: JSON.stringify(literal) }, { value: JSON.stringify(literal) }] : ['1', 'string', { value: JSON.stringify(literal) }])]).flat(), 'finish', 'no'];
  const script = ['0' as string | { value: string }].concat(Array.from({ length: blocks }, (_, b) => chunk(b)).flat(), 'finish');
  const expected = script.length;
  const waves = blocks * Array.from({ length: per }, (_, i) => i % 2).filter(Boolean).length;
  const provider = new LongProvider(script);
  const decisions = new Decisions(provider, 1000, new AbortController().signal);
  const result = await generatePythonAst(decisions, { task: { prompt: `Python print "${literal}" ${blocks * per} times.` } }, 'content', { maxSteps: 1000, maxBytes: 256_000, allowEmpty: false, fragments: [] });
  assert.equal(result.split('\n').filter(Boolean).length, lines);
  assert.equal(provider.requests.length, expected - waves, 'each two-argument print collapses its sibling productions into one wave');
  assert.ok(provider.requests.every(size => size <= MAX_GRID_REQUEST_BYTES), `largest request ${Math.max(...provider.requests)}`);
});

test('decision states that already fit are returned unchanged with nothing trimmed', () => {
  const state = { task: { prompt: 'small' }, history: [{ turn: 1, tool: 'read_file', ok: true, output: 'ok' }], recent: [] };
  const fit = fitDecisionState(state, candidate => bytes({ state: candidate }), MAX_DECISION_REQUEST_BYTES);
  assert.equal(fit.overBudget, false);
  assert.deepEqual(fit.trimmed, []);
  assert.equal(fit.state, state, 'a fitting state is not copied or compacted');
  assert.equal(fit.bytes, bytes({ state }));
  assert.equal(fit.cap, MAX_DECISION_REQUEST_BYTES);
});

test('a 60-turn state with large outputs compacts under the cap and keeps the newest evidence', () => {
  const records = Array.from({ length: 60 }, (_, index) => ({ turn: index + 1, tool: 'bash', args: { command: `run ${index}`, timeout_ms: '' },
    result: { ok: index % 3 !== 0, output: `out ${index} ` + 'x'.repeat(5000) } }));
  const state = { task: { prompt: 'keep probing' },
    conversation: [{ prompt: 'c'.repeat(3000), status: 'completed', summary: 's'.repeat(3000) }],
    observations: Array.from({ length: 8 }, (_, index) => ({ turn: index, tool: 'bash', args: { command: 'observe' }, result: { ok: true, output: 'o'.repeat(5000) } })),
    plan: 'p'.repeat(4000),
    history: records.slice(0, -8).map(record => ({ turn: record.turn, tool: record.tool, ok: record.result.ok, output: record.result.output })),
    recent: records.slice(-8) };
  const measure = (candidate: Record<string, unknown>): number => bytes({ state: candidate, questions: {} });
  assert.ok(measure(state) > MAX_DECISION_REQUEST_BYTES, 'the raw 60-turn state is over the cap');
  const fit = fitDecisionState(state, measure, MAX_DECISION_REQUEST_BYTES);
  assert.equal(fit.overBudget, false);
  assert.ok(fit.bytes <= MAX_DECISION_REQUEST_BYTES, `${fit.bytes} bytes after compaction`);
  assert.deepEqual(fit.trimmed, ['history', 'recent', 'observations', 'conversation', 'plan']);
  const recent = fit.state.recent as Array<{ turn: number }>;
  assert.deepEqual(recent.map(record => record.turn), [57, 58, 59, 60]);
  const history = fit.state.history as Array<{ turn: number }>;
  assert.equal(history.length, 12);
  assert.equal(history.at(-1)!.turn, 52, 'history keeps the newest one-line records');
  const observations = fit.state.observations as Array<{ turn: number }>;
  assert.deepEqual(observations.map(record => record.turn), [4, 5, 6, 7], 'observations keep the newest records');
});

test('a required task over the cap reports overBudget instead of dropping the task', () => {
  const state = { task: { prompt: 'x'.repeat(30_000) }, history: [], recent: [] };
  const fit = fitDecisionState(state, candidate => bytes({ state: candidate }), 1000);
  assert.equal(fit.overBudget, true);
  assert.ok(fit.bytes > 1000);
  assert.equal((fit.state.task as { prompt: string }).prompt.length, 30_000);
});

test('a prior failure reason survives compaction for the next decision', () => {
  const reason = 'ERROR: no module named frobnicate';
  const state = { task: { prompt: 'run the tool' }, history: [],
    recent: [{ turn: 4, tool: 'bash', args: { command: 'frobnicate' }, result: { ok: false, output: `${reason}\n${'y'.repeat(9000)}` } }] };
  const fit = fitDecisionState(state, candidate => bytes({ state: candidate }), 1500);
  assert.equal(fit.overBudget, false);
  const recent = fit.state.recent as Array<{ result: { ok: boolean; output: string } }>;
  assert.equal(recent[0]!.result.ok, false);
  assert.ok(recent[0]!.result.output.includes(reason), `clipped output keeps the reason: ${recent[0]!.result.output.slice(0, 80)}`);
  assert.ok(recent[0]!.result.output.includes('[context clipped]'));
});

test('the completion profile keeps result data that the default profile clips', () => {
  const state = { task: { prompt: 'judge' }, recent: [{ turn: 1, tool: 'probe', args: {}, result: { ok: true, output: 'done', data: { blob: 'd'.repeat(4000) } } }] };
  const measure = (candidate: Record<string, unknown>): number => bytes({ state: candidate });
  const action = fitDecisionState(state, measure, 1000, DECISION_COMPACTION);
  assert.equal(action.overBudget, false, 'the default profile clips result data and fits');
  assert.ok(JSON.stringify(action.state).length < JSON.stringify(state).length);
  const completion = fitDecisionState(state, measure, 1000, COMPLETION_COMPACTION);
  assert.equal(completion.overBudget, true, 'unclipped completion evidence can remain over budget');
  assert.ok(JSON.stringify(completion.state).includes('d'.repeat(4000)));
});

test('choice and probability byte helpers measure the same question envelope the session sends', () => {
  const state = { task: { prompt: 'x' } };
  const criteria = { a: 'A.', b: 'B.' };
  assert.equal(decisionChoiceBytes(state, 'Choose.', criteria), bytes({ state, questions: { selection: { type: 'choice', instructions: 'Choose.', criteria } } }));
  assert.equal(decisionProbabilityBytes(state, 'Are you sure?'), bytes({ state, questions: { verdict: { type: 'noul', instructions: 'Are you sure?' } } }));
  assert.ok(decisionChoiceBytes(state, 'Choose.', criteria) > decisionProbabilityBytes(state, 'Are you sure?'));
});
