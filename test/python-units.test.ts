import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Decisions } from '../src/decisions.js';
import { generatePythonAst } from '../src/python-ast.js';
import { LimitError, type DecisionProvider } from '../src/types.js';
import { SlotProvider, type SlotEntry } from './helpers.js';

interface UnitState { generation: { slot: string; unit?: string; peers?: Array<{ name: string; arity: number; purpose: string }>; partialSource: string } }
type Hold = (state: UnitState, signal?: AbortSignal) => Promise<void> | void;

class GateProvider implements DecisionProvider {
  readonly inner: SlotProvider;
  readonly seen: UnitState[] = [];
  readonly criteria: Array<{ slot: string; unit?: string; keys: string[] }> = [];
  pending = 0;
  maxPending = 0;
  constructor(script: SlotEntry[], private readonly hold?: Hold) { this.inner = new SlotProvider(script); }
  async decide<Q extends Questions>(input: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    const state = input as unknown as UnitState;
    this.seen.push(structuredClone(state));
    const question = questions.selection;
    if (question?.type === 'choice') this.criteria.push({ slot: state.generation.slot, ...(state.generation.unit === undefined ? {} : { unit: state.generation.unit }), keys: Object.keys(question.criteria) });
    this.pending++;
    this.maxPending = Math.max(this.maxPending, this.pending);
    try { await this.hold?.(state, signal); return await this.inner.decide(input, questions, signal); }
    finally { this.pending--; }
  }
}

const options = { maxSteps: 200, maxBytes: 8000, allowEmpty: false, fragments: [] };
const decisions = (provider: DecisionProvider, max = 200) => new Decisions(provider, max, new AbortController().signal);
const prompt = 'Write Python helper functions greet(name) and shout(name), then print greet.';
const state = { task: { prompt, turn: 1, updates: [] } };
const decomposition: SlotEntry[] = [
  { slot: 'unit_count', answer: '2' },
  { slot: 'unit_0_name', answer: { value: 'greet' } }, { slot: 'unit_0_arity', answer: '1' }, { slot: 'unit_0_purpose', answer: { value: 'greet' } }, { slot: 'unit_0_parameter_0', answer: { value: 'name' } },
  { slot: 'unit_1_name', answer: { value: 'shout' } }, { slot: 'unit_1_arity', answer: '1' }, { slot: 'unit_1_purpose', answer: { value: 'shout' } }, { slot: 'unit_1_parameter_0', answer: { value: 'name' } },
];
const bodies: SlotEntry[] = [
  { unit: 'greet', slot: 'function_body', answer: 'return' }, { unit: 'greet', slot: 'expression', answer: 'string' }, { unit: 'greet', slot: 'string', answer: { value: 'greet' } },
  { unit: 'shout', slot: 'function_body', answer: 'return' }, { unit: 'shout', slot: 'expression', answer: 'name' }, { unit: 'shout', slot: 'reference', answer: 'name_0' },
];
const main: SlotEntry[] = [
  { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' }, once: true }, { slot: 'argument_count', answer: '1' },
  { slot: 'argument_0', answer: 'call', once: true }, { slot: 'callee', answer: { value: 'greet' } }, { slot: 'argument_0', answer: 'string' }, { slot: 'string', answer: { value: 'greet' } },
  { slot: 'module_body', answer: 'finish' },
];
const withTimeout = <T>(promise: Promise<T>, ms = 8000): Promise<T> => Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))]);

test('zero units keeps the single-scope path: same source and same slots after the count pick', async () => {
  const provider = new GateProvider([
    { slot: 'unit_count', answer: '0' }, { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' } },
    { slot: 'argument_count', answer: '1' }, { slot: 'argument_0', answer: 'string' }, { slot: 'string', answer: { value: 'Hello, world!' } }, { slot: 'module_body', answer: 'finish' },
  ]);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Create a simple Python hello world.' } }, 'content', options);
  assert.equal(source, "print('Hello, world!')\n");
  assert.deepEqual(provider.seen.map(s => s.generation.slot), ['unit_count', 'module_body', 'expression', 'callee', 'argument_count', 'argument_0', 'string', 'module_body']);
  assert.ok(provider.seen.every(s => s.generation.unit === undefined && s.generation.peers === undefined));
});

test('two units generate concurrently and the main block calls them', async () => {
  let arrived = 0, release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const provider = new GateProvider([...decomposition, ...bodies, ...main], async (s, signal) => {
    if (s.generation.slot !== 'function_body') return;
    if (++arrived === 2) release();
    await Promise.race([both, new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))]);
  });
  const source = await withTimeout(generatePythonAst(decisions(provider), state, 'content', options));
  assert.match(source, /def greet\(name\):\n    return 'greet'\n/);
  assert.match(source, /def shout\(name\):\n    return name\n/);
  assert.match(source, /print\(greet\('greet'\)\)\n$/);
  assert.ok(source.indexOf('def greet') < source.indexOf('def shout') && source.indexOf('def shout') < source.indexOf('print('));
  const greet = provider.seen.find(s => s.generation.unit === 'greet' && s.generation.slot === 'function_body')!;
  assert.deepEqual(greet.generation.peers, [{ name: 'greet', arity: 1, purpose: 'greet' }, { name: 'shout', arity: 1, purpose: 'shout' }]);
  assert.match(greet.generation.partialSource, /def greet\(name\):/);
  assert.doesNotMatch(greet.generation.partialSource, /def shout/);
});

test('a unit calling a peer is constrained to the peer arity', async () => {
  const provider = new GateProvider([...decomposition,
    { unit: 'greet', slot: 'function_body', answer: 'return' }, { unit: 'greet', slot: 'expression', answer: 'string' }, { unit: 'greet', slot: 'string', answer: { value: 'greet' } },
    { unit: 'shout', slot: 'function_body', answer: 'return' }, { unit: 'shout', slot: 'expression', answer: 'call' }, { unit: 'shout', slot: 'callee', answer: { value: 'greet' } },
    { unit: 'shout', slot: 'argument_count', answer: '1' }, { unit: 'shout', slot: 'argument_0', answer: 'name' }, { unit: 'shout', slot: 'reference', answer: 'name_0' },
    { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'shout' } }, { slot: 'argument_count', answer: '1' },
    { slot: 'argument_0', answer: 'string' }, { slot: 'string', answer: { value: 'name' } }, { slot: 'module_body', answer: 'finish' },
  ]);
  const source = await generatePythonAst(decisions(provider), state, 'content', options);
  assert.match(source, /def shout\(name\):\n    return greet\(name\)/);
  assert.equal(provider.criteria.filter(c => c.unit === 'shout' && c.slot === 'argument_count').length, 0, 'peer arity is known, so no count is asked');
  const callee = provider.criteria.find(c => c.unit === 'shout' && c.slot === 'callee')!;
  assert.ok(callee.keys.length > 0);
});

test('one failing unit aborts the other in-flight unit and nothing is produced', async () => {
  const provider = new GateProvider([...decomposition, { unit: 'shout', slot: 'function_body', answer: 'return' }], async (s, signal) => {
    if (s.generation.unit !== 'shout' || s.generation.slot !== 'function_body') return;
    await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
  });
  const events: boolean[] = [];
  await assert.rejects(withTimeout(generatePythonAst(decisions(provider), state, 'content', { ...options, onText: async (_f, _t, done) => { events.push(done); } })), /no entry for .*greet/);
  assert.ok(!events.includes(true));
});

test('the shared request budget holds across forks and surfaces LimitError', async () => {
  const provider = new GateProvider([...decomposition, ...bodies, ...main]);
  const d = decisions(provider, 12);
  await assert.rejects(generatePythonAst(d, state, 'content', options), LimitError);
  assert.ok(d.requests <= 12);
});

test('at most four unit requests are in flight with six units', async () => {
  const units: SlotEntry[] = [{ slot: 'unit_count', answer: '6' }];
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  names.forEach((n, i) => units.push({ slot: `unit_${i}_name`, answer: { value: n } }, { slot: `unit_${i}_arity`, answer: '0' }, { slot: `unit_${i}_purpose`, answer: { value: 'helper' } }));
  const provider = new GateProvider([...units, ...names.map(() => ({ slot: 'function_body', answer: 'pass', once: true })), { slot: 'function_body', answer: 'finish' },
    { slot: 'module_body', answer: 'pass', once: true }, { slot: 'module_body', answer: 'finish' }], async s => { if (s.generation.unit) await new Promise(resolve => setTimeout(resolve, 15)); });
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Python helper functions a b c d e f.' } }, 'content', options);
  assert.equal((source.match(/^def /gm) ?? []).length, 6);
  assert.ok(provider.maxPending <= 4, `max in flight ${provider.maxPending}`);
  assert.ok(provider.maxPending >= 2, `units did not overlap: ${provider.maxPending}`);
});

test('text events during unit generation carry the unit and the assembled module', async () => {
  const provider = new GateProvider([...decomposition, ...bodies, ...main]);
  const events: Array<{ unit?: string; text: string }> = [];
  await generatePythonAst(decisions(provider), state, 'content', { ...options, onText: async (_f, text, _d, _c, progress) => { events.push({ ...(progress?.ast?.unit === undefined ? {} : { unit: progress.ast.unit }), text }); } });
  const during = events.filter(e => e.unit !== undefined);
  assert.ok(during.length >= 6);
  for (const e of during) { assert.match(e.text, /def greet\(name\):/); assert.match(e.text, /def shout\(name\):/); }
  assert.ok(during.some(e => e.unit === 'greet') && during.some(e => e.unit === 'shout'));
});
