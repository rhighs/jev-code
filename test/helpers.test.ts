import test from 'node:test';
import assert from 'node:assert/strict';
import { choice, noul, score } from '@typesafe-ai/sdk';
import { SlotProvider } from './helpers.js';

const state = (slot: string, extra: Record<string, unknown> = {}) => ({ task: { prompt: 'x' }, generation: { field: 'content', phase: 'ast', slot, ...extra } });

test('slot provider answers by slot regardless of arrival order and records every request', async () => {
  const provider = new SlotProvider([
    { phase: 'ast', slot: 'module_body', answer: 'expr' },
    { phase: 'ast', slot: /^argument_/, answer: 'string' },
  ]);
  const criteria = { expr: 'Evaluate', assign: 'Assign', string: 'A literal string.' };
  const [second, first] = await Promise.all([
    provider.decide(state('argument_0'), { selection: choice('pick', criteria) }),
    provider.decide(state('module_body'), { selection: choice('pick', criteria) }),
  ]);
  assert.equal(first.answers.selection.choice, 'expr');
  assert.equal(second.answers.selection.choice, 'string');
  assert.deepEqual(first.answers.selection.probabilities, { expr: 1, assign: 0, string: 0 });
  assert.equal(provider.states.length, 2);
  assert.equal(provider.calls, 2);
});

test('slot provider throws for unmatched requests naming phase and slot', async () => {
  const provider = new SlotProvider([{ phase: 'ast', slot: 'module_body', answer: 'expr' }]);
  await assert.rejects(provider.decide(state('callee'), { selection: choice('pick', { a: 'A', b: 'B' }) }), /ast.*callee/);
  await assert.rejects(provider.decide(state('module_body'), { selection: choice('pick', { a: 'A', b: 'B' }) }), /expr/);
});

test('slot provider answers score questions with a full distribution over rubric levels', async () => {
  const provider = new SlotProvider([{ phase: 'search', slot: 'rank', answer: { score: 2 } }]);
  const res = await provider.decide({ generation: { phase: 'search', slot: 'rank' } }, { quality: score('rate', ['bad', 'ok', 'good', 'best']) });
  assert.equal(res.answers.quality.type, 'score');
  assert.equal(res.answers.quality.score, 2);
  assert.deepEqual(res.answers.quality.probabilities, { 0: 0, 1: 0, 2: 1, 3: 0 });
  assert.deepEqual(res.answers.quality.legend, { 0: 'bad', 1: 'ok', 2: 'good', 3: 'best' });
});

test('slot provider selects criteria by value, matches unit and question key, honors once and noul', async () => {
  const provider = new SlotProvider([
    { phase: 'ast', slot: 'string', unit: 'helper', answer: { value: 'Hello' } },
    { phase: 'ast', slot: 'string', answer: { value: 'World' } },
    { slot: 'verdict', answer: { noul: 0.25 } },
    { slot: 'action', answer: 'bash', once: true },
    { slot: 'action', answer: 'finish' },
  ]);
  const criteria = { value_0: JSON.stringify('World'), value_1: JSON.stringify('Hello'), custom: 'Compose' };
  const helper = await provider.decide(state('string', { unit: 'helper' }), { selection: choice('pick', criteria) });
  const plain = await provider.decide(state('string'), { selection: choice('pick', criteria) });
  assert.equal(helper.answers.selection.choice, 'value_1');
  assert.equal(plain.answers.selection.choice, 'value_0');
  const verdict = await provider.decide({ task: { prompt: 'x' } }, { verdict: noul('done?') });
  assert.equal(verdict.answers.verdict.noul, 0.25);
  const actions = { bash: 'Run', finish: 'Done' };
  const a = await provider.decide({ task: { prompt: 'x' } }, { action: choice('next', actions) });
  const b = await provider.decide({ task: { prompt: 'x' } }, { action: choice('next', actions) });
  assert.equal(a.answers.action.choice, 'bash');
  assert.equal(b.answers.action.choice, 'finish');
});
