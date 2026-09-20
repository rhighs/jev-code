import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Decisions } from '../src/decisions.js';
import { DecisionError, type DecisionEventData, type DecisionProvider } from '../src/types.js';

const levels = ['bad', 'partial', 'noisy', 'good'];
const legend = Object.fromEntries(levels.map((level, index) => [String(index), level]));
const provider = (answer: unknown): DecisionProvider => ({ decide: async <Q extends Questions>(_state: EntryType, questions: Q) =>
  ({ model: 'fake', usage: { input_tokens: 1, output_tokens: 0 }, answers: Object.fromEntries(Object.keys(questions).map(k => [k, answer])) }) as unknown as SystemOneResult<Q> });
const decisions = (p: DecisionProvider) => new Decisions(p, 10, new AbortController().signal);

test('score returns the expected level from a full distribution', async () => {
  const result = await decisions(provider({ type: 'score', score: 2.5, confidence: 0.8, legend, probabilities: { '0': 0, '1': 0, '2': 0.5, '3': 0.5 } })).score({}, 'rate', levels);
  assert.equal(result.expected, 2.5);
  assert.deepEqual(result.probabilities, [0, 0, 0.5, 0.5]);
});

test('score rejects answers without probabilities or with levels outside the rubric', async () => {
  await assert.rejects(decisions(provider({ type: 'score', score: 1, confidence: 1, legend: {} })).score({}, 'rate', levels), DecisionError);
  await assert.rejects(decisions(provider({ type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } })).score({}, 'rate', levels), DecisionError);
  await assert.rejects(decisions(provider({ type: 'score', score: 7, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 } })).score({}, 'rate', levels), DecisionError);
  await assert.rejects(decisions(provider({ type: 'choice', choice: '3', confidence: 1, probabilities: { '3': 1 } })).score({}, 'rate', levels), DecisionError);
});

test('compatibility choices reject incomplete and non-normalized distributions', async () => {
  await assert.rejects(decisions(provider({ type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1 } })).choose({}, 'pick', { a: 'A', b: 'B' }), DecisionError);
  await assert.rejects(decisions(provider({ type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 0.4, b: 0.4 } })).choose({}, 'pick', { a: 'A', b: 'B' }), DecisionError);
});

test('choices accept a distribution whose two-decimal rounding drifts from one', async () => {
  const labels = Array.from({ length: 33 }, (_, i) => `value_${i}`);
  const probabilities = Object.fromEntries(labels.map(l => [l, 0.03]));
  const result = await decisions(provider({ type: 'choice', choice: 'value_4', confidence: 0.3, probabilities })).choose({}, 'pick', Object.fromEntries(labels.map(l => [l, l])));
  assert.equal(result, 'value_4');
  const zeros = Object.fromEntries(labels.map(l => [l, 0]));
  await assert.rejects(decisions(provider({ type: 'choice', choice: 'value_4', confidence: 0.3, probabilities: zeros })).choose({}, 'pick', Object.fromEntries(labels.map(l => [l, l]))), DecisionError);
});

test('compatibility state projection omits optional undefined values without bypassing strict JSON validation', async () => {
  let observed: EntryType | undefined;
  const recording: DecisionProvider = {
    decide: async <Q extends Questions>(state: EntryType, questions: Q) => {
      observed = state;
      return provider({ type: 'noul', noul: 1 }).decide(state, questions);
    },
  };
  await decisions(recording).probability({ optional: undefined, nested: { present: true, missing: undefined } }, 'ready?');
  assert.deepEqual(observed, { nested: { present: true } });
  await assert.rejects(decisions(recording).probability({ invalid: Number.NaN }, 'ready?'), /JSON-compatible/);
});

test('a request queued behind the in-flight cap rejects when the shared signal aborts', async () => {
  const ctrl = new AbortController();
  const hanging: DecisionProvider = { decide: (_state, _questions, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) };
  const d = new Decisions(hanging, 10, ctrl.signal, undefined, 1);
  const first = d.choose({}, 'pick', { a: 'A', b: 'B' });
  const second = d.choose({}, 'pick', { a: 'A', b: 'B' });
  await new Promise(r => setTimeout(r, 20));
  ctrl.abort(new Error('stop'));
  await assert.rejects(first, /stop/);
  await assert.rejects(second, /stop/);
});

test('choose, probability and score all attach the generation identity and the winner options', async () => {
  const seen: DecisionEventData[] = [];
  const state = { generation: { field: 'content', phase: 'ast', slot: 'module_body', unit: 'greet', candidate: 1 } };
  const d = (answer: unknown) => new Decisions(provider(answer), 10, new AbortController().signal).observe(async data => { seen.push(data); });
  await d({ type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } }).choose(state, 'pick', { a: 'A', b: 'B' });
  await d({ type: 'noul', noul: 0.7 }).probability(state, 'true?');
  await d({ type: 'score', score: 2, confidence: 0.8, legend, probabilities: { '0': 0, '1': 0, '2': 1, '3': 0 } }).score(state, 'rate', levels);
  for (const data of seen) {
    assert.equal(data.field, 'content');
    assert.equal(data.slot, 'module_body');
    assert.equal(data.unit, 'greet');
    assert.equal(data.candidate, 1);
  }
  assert.deepEqual(seen[0]!.options, [{ label: 'a', probability: 0.9 }, { label: 'b', probability: 0.1 }]);
  assert.equal(seen[1]!.probability, 0.7);
  assert.deepEqual(seen[2]!.options, [{ label: 'noisy', probability: 1 }, { label: 'bad', probability: 0 }, { label: 'partial', probability: 0 }, { label: 'good', probability: 0 }]);
});
