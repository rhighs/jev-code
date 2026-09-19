import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import {
  CancelledError,
  DecisionError,
  DecisionSession,
  LimitError,
  RunResources,
  type DecisionProvider,
} from '../src/sdk/index.js';

const responseProvider = (answer: unknown): DecisionProvider => ({
  decide: async <Q extends Questions>(_state: EntryType, questions: Q) => ({
    model: 'deterministic',
    usage: { input_tokens: 2, output_tokens: 1 },
    answers: Object.fromEntries(Object.keys(questions).map(key => [key, answer])),
  }) as unknown as SystemOneResult<Q>,
});

test('public decisions return typed metadata for choice, probability, and score', async () => {
  const resources = new RunResources({ limits: { decisions: 3 } });
  const choice = await new DecisionSession(responseProvider({
    type: 'choice', choice: 'technical', confidence: 0.8,
    probabilities: { billing: 0.2, technical: 0.8 },
  }), { resources }).choose({}, 'Route this ticket.', { billing: 'Billing', technical: 'Technical' });
  const probability = await new DecisionSession(responseProvider({ type: 'noul', noul: 0.7 }), { resources })
    .probability({}, 'Is this urgent?');
  const score = await new DecisionSession(responseProvider({
    type: 'score', score: 1.75, confidence: 0.9, legend: {},
    probabilities: { '0': 0, '1': 0.25, '2': 0.75 },
  }), { resources }).score({}, 'Rate urgency.', ['low', 'medium', 'high']);

  assert.equal(choice.value, 'technical');
  assert.equal(choice.metadata.probability, 0.8);
  assert.equal(choice.metadata.model, 'deterministic');
  assert.deepEqual(choice.metadata.alternatives, [
    { label: 'technical', probability: 0.8 },
    { label: 'billing', probability: 0.2 },
  ]);
  assert.equal(probability.value, 0.7);
  assert.equal(score.value.expected, 1.75);
  assert.deepEqual(resources.snapshot(), {
    used: { decisions: 3, nodes: 0 },
    limits: { decisions: 3, nodes: Number.MAX_SAFE_INTEGER },
    usage: { inputTokens: 6, outputTokens: 3 },
    inflight: 0,
  });
});

test('choice rejects missing, extra, non-finite, and non-normalized probabilities', async () => {
  const invalid = [
    { a: 1 },
    { a: 0.5, b: 0.5, c: 0 },
    { a: Number.NaN, b: 0 },
    { a: 0.6, b: 0.3 },
  ];
  for (const probabilities of invalid) {
    await assert.rejects(
      new DecisionSession(responseProvider({ type: 'choice', choice: 'a', confidence: 1, probabilities }))
        .choose({}, 'pick', { a: 'A', b: 'B' }),
      (error: unknown) => error instanceof DecisionError && error.evidence.kind === 'invalid-response',
    );
  }
});

test('forks share the decision budget and do not issue an eleventh call', async () => {
  let calls = 0;
  const provider: DecisionProvider = {
    decide: async <Q extends Questions>(_state: EntryType, questions: Q) => {
      calls++;
      return {
        model: 'local', usage: { input_tokens: 0, output_tokens: 0 },
        answers: Object.fromEntries(Object.keys(questions).map(key => [key, {
          type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 },
        }])),
      } as unknown as SystemOneResult<Q>;
    },
  };
  const root = new DecisionSession(provider, { limits: { decisions: 10 }, concurrency: 3 });
  const child = root.fork(new AbortController().signal);
  const outcomes = await Promise.allSettled(Array.from({ length: 11 }, (_, index) =>
    (index % 2 ? root : child).choose({ index }, 'pick', { a: 'A', b: 'B' })));

  assert.equal(calls, 10);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 10);
  const rejected = outcomes.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof LimitError);
  assert.equal(rejected.reason.evidence.kind, 'exhausted');
  assert.equal(rejected.reason.evidence.resource, 'decisions');
});

test('run resource dimensions are shared across forks', () => {
  const root = new RunResources({ limits: { decisions: 1, nodes: 1 } });
  const child = root.fork();
  child.reserve('nodes');
  assert.deepEqual(root.snapshot().used, { decisions: 0, nodes: 1 });
  assert.throws(() => root.reserve('nodes'), (error: unknown) =>
    error instanceof LimitError && error.evidence.kind === 'exhausted' && error.evidence.resource === 'nodes');
});

test('decision projections reject values that JSON serialization would silently alter', async () => {
  const session = new DecisionSession(responseProvider({ type: 'noul', noul: 1 }));
  await assert.rejects(session.probability({ omitted: undefined } as never, 'ready?'), /JSON-compatible/);
  await assert.rejects(session.probability({ invalid: Number.NaN } as never, 'ready?'), /JSON-compatible/);
});

test('queued decisions share concurrency and recheck the global budget before dispatch', async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const provider: DecisionProvider = {
    decide: async <Q extends Questions>(_state: EntryType, questions: Q) => {
      calls++;
      await new Promise<void>(resolve => { releases.push(resolve); });
      return {
        model: 'queued', usage: { input_tokens: 0, output_tokens: 0 },
        answers: Object.fromEntries(Object.keys(questions).map(key => [key, {
          type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 },
        }])),
      } as unknown as SystemOneResult<Q>;
    },
  };
  const session = new DecisionSession(provider, { limits: { decisions: 2 }, concurrency: 1 });
  const pending = Array.from({ length: 3 }, () => session.choose({}, 'pick', { a: 'A', b: 'B' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  releases.shift()?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  releases.shift()?.();
  const outcomes = await Promise.allSettled(pending);
  assert.equal(calls, 2);
  assert.equal(outcomes[2]?.status, 'rejected');
});

test('provider failure, caller cancellation, and deadline expiry retain distinct evidence', async () => {
  await assert.rejects(
    new DecisionSession({ decide: async () => { throw new Error('offline'); } }).probability({}, 'ready?'),
    (error: unknown) => error instanceof DecisionError && error.evidence.kind === 'provider-failure',
  );

  const hanging: DecisionProvider = {
    decide: (_state, _questions, signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  };
  const caller = new AbortController();
  const cancelled = new DecisionSession(hanging, { signal: caller.signal }).probability({}, 'ready?');
  caller.abort(new Error('caller stopped'));
  await assert.rejects(cancelled, (error: unknown) =>
    error instanceof CancelledError && error.evidence.kind === 'cancelled' && error.message.includes('caller stopped'));

  await assert.rejects(
    new DecisionSession(hanging, { timeoutMs: 10 }).probability({}, 'ready?'),
    (error: unknown) => error instanceof LimitError && error.evidence.kind === 'deadline-exceeded',
  );
});
