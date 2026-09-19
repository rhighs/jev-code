import assert from 'node:assert/strict';
import test from 'node:test';
import { AstRegistry } from '../src/ast-adapters.js';
import { Decisions } from '../src/decisions.js';
import { generateText } from '../src/generation.js';
import type { DecisionProvider } from '../src/types.js';
import { ScriptedProvider } from './helpers.js';
import { MAX_GRID_REQUEST_BYTES } from '../src/scored-grid.js';

const task = { task: { turn: 1, prompt: 'Generate text.', updates: [] }, action: 'write_file' };
const options = { experimentalGrid: true, fragments: [], maxSteps: 128, maxBytes: 1000, allowEmpty: false };

test('experimental grid asks one Choice per output cell concurrently and decodes candidate probabilities', async () => {
  const target = 'ab\ncd';
  let active = 0, peak = 0, cellsAsked = 0;
  const provider: DecisionProvider = { decide: async (state, questions) => {
    const generation = (state as unknown as { generation: { phase: string; grid: {
      alphabet: Array<{ key: string; value: string }>; rows: number; columns: number; capacity: number;
    } } }).generation;
    if (questions.selection?.type === 'choice') return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 },
      answers: { selection: { type: 'choice', choice: 'cells_8', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(questions.selection.criteria).map(key => [key, key === 'cells_8' ? 1 : 0])) } } } as never;
    if (questions.verdict) return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 }, answers: { verdict: { type: 'noul', noul: 1 } } } as never;
    assert.equal(generation.phase, 'cells');
    assert.equal(generation.grid.capacity, 8);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(questions)) {
      assert.equal(question.type, 'choice');
      if (question.type !== 'choice') throw new Error('Expected parallel Choice cells.');
      const [, row, column] = /^cell_(\d+)_(\d+)$/.exec(key)!;
      const index = Number(row) * generation.grid.columns + Number(column);
      const value = [...target][index] ?? '';
      const symbol = generation.grid.alphabet.find(symbol => symbol.value === value)!;
      answers[key] = { type: 'choice', choice: symbol.key, confidence: 0.1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === symbol.key ? 1 : 0])) };
      cellsAsked++;
    }
    active--;
    return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 }, answers } as never;
  } };
  const changes: unknown[] = [];
  const actual = await generateText(new Decisions(provider, 50, new AbortController().signal), {}, 'content', 'Write a file.', {
    experimentalGrid: true, fragments: [], maxSteps: 8, maxBytes: 100, allowEmpty: false, gridBatchSize: 2, concurrency: 4,
    onText: async (_field, _text, _done, change) => { if (change) changes.push(change); },
  });
  assert.equal(actual, target);
  assert.equal(cellsAsked, 8);
  assert.equal(peak, 4);
  assert.equal(changes.some(change => typeof change === 'object' && change !== null && 'append' in change), false);
});

test('large requested batches split before exceeding the request payload budget', async () => {
  const base = new ScriptedProvider([{ action: 'write_file', args: { content: 'hello' } }]);
  let calls = 0, peakQuestions = 0;
  const provider: DecisionProvider = { decide: async (state, questions, signal) => {
    if (questions.cell_0_0 || Object.keys(questions).some(key => key.startsWith('cell_'))) {
      assert.ok(Buffer.byteLength(JSON.stringify({ state, questions })) <= MAX_GRID_REQUEST_BYTES);
      peakQuestions = Math.max(peakQuestions, Object.keys(questions).length);
      calls++;
    }
    if (questions.selection?.type === 'choice') return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 },
      answers: { selection: { type: 'choice', choice: 'cells_128', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(questions.selection.criteria).map(key => [key, key === 'cells_128' ? 1 : 0])) } } } as never;
    return base.decide(state, questions, signal);
  } };
  assert.equal(await generateText(new Decisions(provider, 100, new AbortController().signal), task, 'content', 'Exact text.',
    { ...options, gridBatchSize: 128 }), 'hello');
  assert.ok(calls > 1);
  assert.ok(peakQuestions < 128);
});

test('max_tokens_exceeded retries smaller parallel Choice batches against the same grid', async () => {
  const base = new ScriptedProvider([{ action: 'write_file', args: { content: 'hello' } }]);
  let rejected = 0, requests = 0;
  const provider: DecisionProvider = { decide: async (state, questions, signal) => {
    requests++;
    if (Object.keys(questions).some(key => key.startsWith('cell_')) && Object.keys(questions).length > 2) {
      rejected++;
      throw new Error('400 {"detail":{"error_type":"max_tokens_exceeded"}}');
    }
    return base.decide(state, questions, signal);
  } };
  const decisions = new Decisions(provider, 100, new AbortController().signal);
  assert.equal(await generateText(decisions, task, 'content', 'Exact text.', { ...options, gridBatchSize: 8 }), 'hello');
  assert.equal(rejected, 3);
  assert.equal(decisions.requests, requests);
});

test('missing END stops after three rounds instead of growing grids until a token error', async () => {
  const base = new ScriptedProvider([{ action: 'write_file', args: { content: 'hello' } }]);
  const rounds = new Set<number>();
  const provider: DecisionProvider = { decide: async (state, questions, signal) => {
    const response = await base.decide(state, questions, signal);
    for (const [key, question] of Object.entries(questions)) if (key.startsWith('cell_') && question.type === 'choice') {
      const generation = (state as unknown as { generation: { round: number } }).generation;
      rounds.add(generation.round);
      (response.answers as Record<string, unknown>)[key] = { type: 'choice', choice: 'x', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, label === 'x' ? 1 : 0])) };
    }
    return response;
  } };
  await assert.rejects(generateText(new Decisions(provider, 100, new AbortController().signal), task, 'content', 'Exact text.', options), /no END after 3 rounds/);
  assert.deepEqual([...rounds], [1, 2, 3]);
});

test('characters after END trigger whole-grid repair rather than discarding output', async () => {
  const base = new ScriptedProvider([{ action: 'write_file', args: { content: 'abc' } }]);
  const rounds = new Set<number>();
  const provider: DecisionProvider = { decide: async (state, questions, signal) => {
    const response = await base.decide(state, questions, signal);
    const generation = (state as unknown as { generation: { phase: string; round: number } }).generation;
    if (generation.phase === 'cells') {
      rounds.add(generation.round);
      const question = questions.cell_0_1;
      if (generation.round === 1 && question?.type === 'choice') (response.answers as Record<string, unknown>).cell_0_1 = {
        type: 'choice', choice: 'END', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, label === 'END' ? 1 : 0])),
      };
    }
    return response;
  } };
  assert.equal(await generateText(new Decisions(provider, 100, new AbortController().signal), task, 'content', 'Exact text.', options), 'abc');
  assert.deepEqual([...rounds], [1, 2]);
});

test('malformed candidate distributions fail without decoding an arbitrary character', async () => {
  for (const malformed of [NaN, -0.1, 1.1, undefined]) {
    const base = new ScriptedProvider([{ action: 'write_file', args: { content: 'hello' } }]);
    const provider: DecisionProvider = { decide: async (state, questions, signal) => {
      const response = await base.decide(state, questions, signal);
      const answer = (response.answers as Record<string, { probabilities?: Record<string, unknown> }>).cell_0_0;
      if (answer?.probabilities) answer.probabilities.a = malformed;
      return response;
    } };
    await assert.rejects(generateText(new Decisions(provider, 100, new AbortController().signal), task, 'content', 'Exact text.', options), /invalid or missing character probability/);
  }
});

test('compiler errors cause a parallel grid repair before ordinary source can finish', async () => {
  const valid = 'export const value = 42;';
  const base = new ScriptedProvider([{ action: 'write_file', args: { content: valid } }]);
  const broken = new ScriptedProvider([{ action: 'write_file', args: { content: '{' } }]);
  let repaired = false;
  const provider: DecisionProvider = { decide: async (state, questions, signal) => {
    const generation = (state as unknown as { generation: { phase: string; round: number; syntax?: unknown[] } }).generation;
    if (generation.phase === 'cells' && generation.round === 1) return broken.decide(state, questions, signal);
    if (generation.phase === 'cells' && generation.round === 2) repaired = true;
    return base.decide(state, questions, signal);
  } };
  assert.equal(await generateText(new Decisions(provider, 100, new AbortController().signal), { ...task, argumentsSoFar: { path: 'sum.ts' } },
    'content', 'Valid TypeScript.', { ...options, astRegistry: new AstRegistry([], false) }), valid);
  assert.equal(repaired, true);
});
