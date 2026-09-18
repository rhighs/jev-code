import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Decisions } from '../src/decisions.js';
import { DecisionError, type DecisionProvider } from '../src/types.js';

const levels = ['bad', 'partial', 'noisy', 'good'];
const provider = (answer: unknown): DecisionProvider => ({ decide: async <Q extends Questions>(_state: EntryType, questions: Q) =>
  ({ model: 'fake', usage: { input_tokens: 1, output_tokens: 0 }, answers: Object.fromEntries(Object.keys(questions).map(k => [k, answer])) }) as unknown as SystemOneResult<Q> });
const decisions = (p: DecisionProvider) => new Decisions(p, 10, new AbortController().signal);

test('score returns the expected level from a full distribution', async () => {
  const result = await decisions(provider({ type: 'score', score: 2.5, confidence: 0.8, legend: {}, probabilities: { '0': 0, '1': 0, '2': 0.5, '3': 0.5 } })).score({}, 'rate', levels);
  assert.equal(result.expected, 2.5);
  assert.deepEqual(result.probabilities, [0, 0, 0.5, 0.5]);
});

test('score rejects answers without probabilities or with levels outside the rubric', async () => {
  await assert.rejects(decisions(provider({ type: 'score', score: 1, confidence: 1, legend: {} })).score({}, 'rate', levels), DecisionError);
  await assert.rejects(decisions(provider({ type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } })).score({}, 'rate', levels), DecisionError);
  await assert.rejects(decisions(provider({ type: 'score', score: 7, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 } })).score({}, 'rate', levels), DecisionError);
  await assert.rejects(decisions(provider({ type: 'choice', choice: '3', confidence: 1, probabilities: { '3': 1 } })).score({}, 'rate', levels), DecisionError);
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
