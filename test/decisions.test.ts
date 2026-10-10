import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Decisions } from '../src/decisions.js';
import { compactRetryState } from '../src/decision-context.js';
import { attemptScope, createRunContext } from '../src/run-context.js';
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

const choiceProvider = (choice: string, probabilities: Record<string, number>): DecisionProvider => ({
  decide: async <Q extends Questions>(_state: EntryType, questions: Q) =>
    ({ model: 'fake', usage: { input_tokens: 1, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(questions).map(k => [k, { type: 'choice', choice, confidence: probabilities[choice] ?? 0, probabilities }])) }) as unknown as SystemOneResult<Q>,
});

test('alternatives-aware choices record a decision path with ids, alternatives, kinds, and event fields', async () => {
  const context = createRunContext();
  const events: DecisionEventData[] = [];
  const scope = attemptScope('content', 'greet');
  const d = new Decisions(choiceProvider('a', { a: 0.9, b: 0.1 }), 10, new AbortController().signal, async data => { events.push(data); }, 4, undefined, context);
  const first = await d.chooseWithAlternatives({ generation: { field: 'content', phase: 'ast', slot: 'module_body', unit: 'greet' } },
    'pick', { a: 'A', b: 'B' }, { scope, questionKey: 'module_body', kind: 'structural' });
  const second = await d.chooseWithAlternatives({ generation: { field: 'content', phase: 'ast', slot: 'string' } },
    'pick', { a: 'A', b: 'B' }, { scope, questionKey: 'string', kind: 'leaf' });

  assert.equal(first.choice, 'a');
  assert.equal(first.nearTie, false);
  assert.equal(first.decisionId, 1);
  assert.equal(second.decisionId, 2);
  assert.deepEqual(first.alternatives, [{ label: 'a', probability: 0.9 }, { label: 'b', probability: 0.1 }]);
  const path = context.pathFor(scope);
  assert.deepEqual(path.map(entry => [entry.decisionId, entry.questionKey, entry.kind]), [[1, 'module_body', 'structural'], [2, 'string', 'leaf']]);
  assert.deepEqual(path[0]!.identity, { field: 'content', phase: 'ast', slot: 'module_body', unit: 'greet' });
  assert.deepEqual(path[0]!.chosen, 'a');
  assert.deepEqual(path[0]!.alternatives, first.alternatives);
  assert.equal(context.decisionEntry(2), path[1]);
  assert.deepEqual(events.map(event => [event.choice, event.decisionId, event.nearTie]), [['a', 1, false], ['a', 2, false]]);
  assert.deepEqual(events[0]!.options, first.alternatives);
  await context.dispose();
});

test('near-tie flags follow the inclusive boundary and the argmax deviation rule', async () => {
  const context = createRunContext();
  const scope = attemptScope('content', 'u');
  const record = async (choice: string, probabilities: Record<string, number>) =>
    new Decisions(choiceProvider(choice, probabilities), 10, new AbortController().signal, undefined, 4, undefined, context)
      .chooseWithAlternatives({}, 'pick', Object.fromEntries(Object.keys(probabilities).map(key => [key, key])), { scope, questionKey: 'slot', kind: 'leaf' });
  const exact = await record('a', { a: 0.55, b: 0.45 });
  assert.equal(exact.nearTie, true, 'a gap of exactly 0.1 is a near-tie');
  const above = await record('a', { a: 0.56, b: 0.45 });
  assert.equal(above.nearTie, false, 'a gap of 0.11 is not a near-tie');
  const deviated = await record('b', { a: 0.8, b: 0.2 });
  assert.equal(deviated.nearTie, true, 'a chosen label that is not the argmax is a near-tie');
  assert.deepEqual(context.pathFor(scope).map(entry => entry.nearTie), [true, false, true]);
  await context.dispose();
});

test('a provider failure leaves the recorded path unchanged for that attempt', async () => {
  const context = createRunContext();
  const scope = attemptScope('content', 'greet');
  let calls = 0;
  const flaky: DecisionProvider = {
    decide: async <Q extends Questions>(_state: EntryType, questions: Q) => {
      calls++;
      if (calls === 2) throw new Error('provider offline');
      return { model: 'flaky', usage: { input_tokens: 1, output_tokens: 0 },
        answers: Object.fromEntries(Object.keys(questions).map(key => [key, { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } }])) } as unknown as SystemOneResult<Q>;
    },
  };
  const d = new Decisions(flaky, 10, new AbortController().signal, undefined, 4, undefined, context);
  await d.chooseWithAlternatives({}, 'pick', { a: 'A', b: 'B' }, { scope, questionKey: 'first', kind: 'structural' });
  await assert.rejects(d.chooseWithAlternatives({}, 'pick', { a: 'A', b: 'B' }, { scope, questionKey: 'second', kind: 'leaf' }), /provider offline/);
  assert.deepEqual(context.pathFor(scope).map(entry => entry.questionKey), ['first']);
  assert.equal(context.pathFor(scope)[0]!.decisionId, 1);
  await context.dispose();
});

test('forked facades share the run context and plain choose keeps its event shape', async () => {
  const context = createRunContext();
  const events: DecisionEventData[] = [];
  const root = new Decisions(choiceProvider('a', { a: 1, b: 0 }), 10, new AbortController().signal, async data => { events.push(data); }, 4, undefined, context);
  const fork = root.fork(new AbortController().signal);
  assert.equal(fork.runContext, context);
  await fork.chooseWithAlternatives({ generation: { field: 'content', phase: 'ast', slot: 'callee', unit: 'greet' } },
    'pick', { a: 'A', b: 'B' }, { scope: attemptScope('content', 'greet'), questionKey: 'callee', kind: 'structural' });
  assert.equal(context.pathFor(attemptScope('content', 'greet')).length, 1);
  await root.choose({ generation: { field: 'content', phase: 'ast', slot: 'callee' } }, 'pick', { a: 'A', b: 'B' });
  assert.equal(events.length, 2);
  assert.equal(events[0]!.decisionId, 1);
  assert.equal(events[1]!.decisionId, undefined);
  assert.equal(events[1]!.nearTie, undefined);
  assert.deepEqual(context.pathFor(attemptScope('content', 'greet')).map(entry => entry.decisionId), [1]);
  await context.dispose();
});

/** A state with compactable context keys, mirroring what harness/generation send. */
const compactableState = (): Record<string, unknown> => ({
  history: Array.from({ length: 20 }, (_, index) => ({ turn: index + 1, tool: 'read_file', ok: true, output: `output ${index} ${'h'.repeat(240)}` })),
  recent: Array.from({ length: 8 }, (_, index) => ({ turn: index + 1, tool: 'bash', args: { command: 'c'.repeat(400) }, result: { ok: true, output: 'r'.repeat(900) } })),
});

/** A provider that fails the first `failures` requests with max_tokens_exceeded, then answers. */
const tokenRetryProvider = (failures: number, answer: (key: string) => unknown): { provider: DecisionProvider; states: Record<string, unknown>[] } => {
  const states: Record<string, unknown>[] = [];
  const provider: DecisionProvider = {
    decide: async <Q extends Questions>(state: EntryType, questions: Q) => {
      states.push(structuredClone(state) as Record<string, unknown>);
      if (states.length <= failures) throw new Error('max_tokens_exceeded: request exceeds the model token budget');
      return { model: 'fake', usage: { input_tokens: 1, output_tokens: 0 },
        answers: Object.fromEntries(Object.keys(questions).map(key => [key, answer(key)])) } as unknown as SystemOneResult<Q>;
    },
  };
  return { provider, states };
};

test('choose, probability, and score compact and retry once on max_tokens_exceeded', async () => {
  const signal = new AbortController().signal;
  const choice = tokenRetryProvider(1, () => ({ type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } }));
  assert.equal(await new Decisions(choice.provider, 10, signal).choose(compactableState(), 'pick', { a: 'A', b: 'B' }, compactRetryState), 'a');
  assert.equal(choice.states.length, 2, 'one rejection plus one retry');
  const retriedChoice = choice.states[1] as { history: unknown[]; recent: Array<{ result: { output: string } }> };
  assert.equal(retriedChoice.history.length, 4, 'the retry state was compacted harder');
  assert.equal(retriedChoice.recent.length, 2);
  assert.ok(retriedChoice.recent[0]!.result.output.length <= 420, 'retry outputs are clipped');

  const noul = tokenRetryProvider(1, () => ({ type: 'noul', noul: 0.8 }));
  assert.equal(await new Decisions(noul.provider, 10, signal).probability(compactableState(), 'true?', compactRetryState), 0.8);
  assert.equal(noul.states.length, 2);

  const rating = tokenRetryProvider(1, () => ({ type: 'score', score: 2, confidence: 0.9, legend, probabilities: { '0': 0, '1': 0, '2': 1, '3': 0 } }));
  assert.deepEqual(await new Decisions(rating.provider, 10, signal).score(compactableState(), 'rate', levels, compactRetryState), { expected: 2, probabilities: [0, 0, 1, 0] });
  assert.equal(rating.states.length, 2);
});

test('a second max_tokens_exceeded rejection fails the decision after one retry', async () => {
  const retry = tokenRetryProvider(2, () => ({ type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } }));
  await assert.rejects(new Decisions(retry.provider, 10, new AbortController().signal).choose(compactableState(), 'pick', { a: 'A', b: 'B' }, compactRetryState),
    /max_tokens_exceeded/);
  assert.equal(retry.states.length, 2, 'the failure propagates after exactly one retry');
});

test('token-budget recovery is opt-in and only matches max_tokens_exceeded', async () => {
  const signal = new AbortController().signal;
  const withoutHook = tokenRetryProvider(3, () => ({ type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } }));
  await assert.rejects(new Decisions(withoutHook.provider, 10, signal).choose(compactableState(), 'pick', { a: 'A', b: 'B' }), /max_tokens_exceeded/);
  assert.equal(withoutHook.states.length, 1, 'no builder means no retry');

  let unrelated = 0;
  const failing: DecisionProvider = { decide: async <Q extends Questions>(_state: EntryType, _questions: Q) => {
    unrelated++;
    throw new Error('provider offline');
  } };
  await assert.rejects(new Decisions(failing, 10, signal).choose(compactableState(), 'pick', { a: 'A', b: 'B' }, compactRetryState), /provider offline/);
  assert.equal(unrelated, 1, 'unrelated failures never retry');
});

test('a builder that cannot compact still retries once with the unchanged state', async () => {
  const retry = tokenRetryProvider(1, () => ({ type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } }));
  assert.equal(await new Decisions(retry.provider, 10, new AbortController().signal).choose({ task: {} }, 'pick', { a: 'A', b: 'B' }, compactRetryState), 'a');
  assert.equal(retry.states.length, 2);
  assert.deepEqual(retry.states[1], retry.states[0], 'an already-minimal state is retried unchanged');
});
