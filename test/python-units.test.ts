import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Decisions } from '../src/decisions.js';
import { createBuilder, generatePythonAst, vocabulary, type Shared } from '../src/python-ast.js';
import { node, type Builder, type PythonNode, type Scope } from '../src/python-nodes.js';
import { fillUnits, type Unit, type UnitCheck, type UnitRepair } from '../src/python-units.js';
import { attemptScope, createRunContext } from '../src/run-context.js';
import { LimitError, type DecisionProvider } from '../src/types.js';
import { SlotProvider, type SlotEntry } from './helpers.js';

interface UnitState { generation: { slot: string; unit?: string; peers?: Array<{ name: string; arity: number; purpose: string }>; partialSource: string; repair?: { reason: string; symbol?: string; snippet?: string } } }
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
const stubUnit = (name: string): Unit => ({ name, arity: 0, purpose: 'helper', params: [], def: node('Module', { body: [] }), body: [] });
const rootScope = (): Scope => ({ names: new Map(), function: false, loop: false });

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

test('a unit whose static check fails twice aborts the other in-flight unit and nothing is produced', async () => {
  const units = [stubUnit('greet'), stubUnit('shout')];
  const aborted: string[] = [];
  let checks = 0;
  const makeBuilder = (unit: Unit, fork: Decisions): Builder => ({
    block: async (): Promise<void> => {
      if (unit.name !== 'shout') return;
      await new Promise<void>(resolve => fork.signal.addEventListener('abort', () => resolve(), { once: true }));
      aborted.push(unit.name);
    },
  }) as unknown as Builder;
  const check: UnitCheck = {
    render: async unit => `def ${unit.name}():\n    pass\n`,
    check: async unit => {
      if (unit.name !== 'greet') return undefined;
      checks++;
      return checks === 1 ? { reason: 'return' } : { reason: 'arity', symbol: 'shout' };
    },
  };
  await assert.rejects(withTimeout(fillUnits(units, decisions(new SlotProvider([])), makeBuilder, rootScope, check)), /static check failed twice.*return then arity/);
  assert.equal(checks, 2, 'one retryable failure retries exactly once before the abort');
  assert.deepEqual(aborted, ['shout'], 'the in-flight unit is aborted by the second failure');
});

test('a fatal generation error is not retried by the static check path', async () => {
  let checks = 0;
  const makeBuilder = (): Builder => ({ block: async () => { throw new Error('provider exploded'); } }) as unknown as Builder;
  await assert.rejects(fillUnits([stubUnit('solo')], decisions(new SlotProvider([])), makeBuilder, rootScope, { render: async () => '', check: async () => { checks++; return undefined; } }), /provider exploded/);
  assert.equal(checks, 0, 'fatal errors never reach the static check');
});

test('a compile failure retries with the source snippet and the reason and no criteria change', async () => {
  const repairs: Array<UnitRepair | undefined> = [];
  const makeBuilder = (_unit: Unit, _fork: Decisions, _candidate?: number, _body?: PythonNode[], repair?: UnitRepair): Builder => {
    repairs.push(repair);
    return { block: async () => {} } as unknown as Builder;
  };
  const source = 'def solo():\n    return (\n';
  let checks = 0;
  const check: UnitCheck = { render: async () => source, check: async () => { checks++; return checks === 1 ? { reason: 'compile' } : undefined; } };
  await fillUnits([stubUnit('solo')], decisions(new SlotProvider([])), makeBuilder, rootScope, check);
  assert.equal(repairs.length, 2, 'one retry in place');
  assert.equal(repairs[0], undefined);
  assert.deepEqual(repairs[1], { reason: 'compile', snippet: source });
});

test('a width-1 unit that fails its static check retries once with the reason and narrowed criteria', async () => {
  const prompt = 'Write a Python helper get_greeting(name) that returns the greeting text, then print it.';
  const provider = new GateProvider([
    { slot: 'unit_count', answer: '1' },
    { slot: 'unit_0_name', answer: { value: 'get_greeting' } }, { slot: 'unit_0_arity', answer: '1' },
    { slot: 'unit_0_purpose', answer: { value: 'returns the greeting' } }, { slot: 'unit_0_parameter_0', answer: { value: 'name' } },
    // The first attempt has no return, so the wants-return static check fails.
    { unit: 'get_greeting', slot: 'function_body', answer: 'pass', once: true },
    { unit: 'get_greeting', slot: 'function_body', answer: 'finish', once: true },
    // The retry is narrowed to the single return production.
    { unit: 'get_greeting', slot: 'function_body', answer: 'return' },
    { unit: 'get_greeting', slot: 'expression', answer: 'string' },
    { unit: 'get_greeting', slot: 'string', answer: { value: 'greeting' } },
    { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' }, once: true }, { slot: 'argument_count', answer: '1' },
    { slot: 'argument_0', answer: 'string' }, { slot: 'string', answer: { value: 'greeting' } },
    { slot: 'module_body', answer: 'finish' },
  ]);
  const source = await generatePythonAst(decisions(provider), { task: { prompt, turn: 1, updates: [] } }, 'content', options);
  assert.equal(source, "def get_greeting(name):\n    return 'greeting'\nprint('greeting')\n");

  const bodyQuestions = provider.criteria.filter(c => c.unit === 'get_greeting' && c.slot === 'function_body');
  assert.equal(bodyQuestions.length, 2, 'the forced-return retry pick is host-derived and asks nothing');
  assert.ok(bodyQuestions[0]!.keys.includes('pass') && bodyQuestions[0]!.keys.includes('return'));

  const retry = provider.seen.find(s => s.generation.unit === 'get_greeting' && s.generation.slot === 'expression');
  assert.equal(retry?.generation.repair?.reason, 'return');
  assert.equal(retry?.generation.repair?.symbol, undefined);
  assert.deepEqual(provider.seen.map(s => s.generation.slot), ['unit_count', 'unit_0_name', 'unit_0_arity', 'unit_0_purpose', 'unit_0_parameter_0',
    'function_body', 'function_body', 'expression', 'string',
    'module_body', 'expression', 'callee', 'argument_count', 'argument_0', 'string', 'module_body']);
});

test('retry narrowing applies the reason table: arity forbids the peer, undefined drops the name, compile keeps criteria', async () => {
  const objective = 'shout the greet message';
  const context = createRunContext();
  const shared: Shared = { field: 'content', options: { ...options, context }, objective, context: {}, budget: { step: 0 }, vocab: vocabulary(objective), maxDepth: 8 };
  const peers = [{ name: 'greet', arity: 1, purpose: 'greet' }];
  const scope: Scope = { names: new Map([['message', { kind: 'variable' }]]), parent: { names: new Map([['greet', { kind: 'function', arity: 1 }]]), function: false, loop: false }, function: true, loop: false };
  const record = (script: SlotEntry[]) => {
    const inner = new SlotProvider(script);
    const seen: Array<{ slot: string; keys: string[]; values: unknown[]; repair?: { reason: string; symbol?: string; snippet?: string } }> = [];
    const provider: DecisionProvider = { decide: async (input, questions, signal) => {
      const generation = (input as { generation: { slot: string; repair?: { reason: string; symbol?: string; snippet?: string } } }).generation;
      const question = questions.selection;
      if (question?.type === 'choice') seen.push({ slot: generation.slot, keys: Object.keys(question.criteria), values: Object.values(question.criteria), ...(generation.repair === undefined ? {} : { repair: generation.repair }) });
      return inner.decide(input, questions, signal);
    } };
    return { provider, seen };
  };
  const script: SlotEntry[] = [{ slot: 'function_body', answer: 'return' }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' } }, { slot: 'argument_count', answer: '0' }];

  const arity = record(script);
  await createBuilder(shared, { decisions: decisions(arity.provider), unit: 'shout', peers, repair: { reason: 'arity', symbol: 'greet' }, render: async () => '', report: async () => {} }).block([], scope, 1, 'function_body');
  const callee = arity.seen.find(entry => entry.slot === 'callee')!;
  assert.ok(callee.values.includes('print'));
  assert.ok(!callee.values.includes('greet'), `the offending peer call is forbidden: ${callee.values.join(', ')}`);

  const undefinedName = record(script);
  await createBuilder(shared, { decisions: decisions(undefinedName.provider), unit: 'shout', peers, repair: { reason: 'undefined', symbol: 'message' }, render: async () => '', report: async () => {} }).block([], scope, 1, 'function_body');
  const reference = undefinedName.seen.find(entry => entry.slot === 'expression')!;
  assert.ok(!reference.keys.includes('name'), `the undefined name is not offered: ${reference.keys.join(', ')}`);

  const compile = record(script);
  await createBuilder(shared, { decisions: decisions(compile.provider), unit: 'shout', peers, repair: { reason: 'compile', snippet: 'def shout():\n    return (' }, render: async () => '', report: async () => {} }).block([], scope, 1, 'function_body');
  const compileExpression = compile.seen.find(entry => entry.slot === 'expression')!;
  assert.equal(compileExpression.repair?.snippet, 'def shout():\n    return (');
  assert.ok(compileExpression.keys.includes('name') && compileExpression.keys.includes('call'), 'compile changes no criteria');
  await context.dispose();
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
    { slot: 'module_body', answer: 'finish' }], async s => { if (s.generation.unit) await new Promise(resolve => setTimeout(resolve, 15)); });
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

test('a prompt without ASCII words skips decomposition instead of failing on an empty purpose vocabulary', async () => {
  const provider = new GateProvider([
    { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' } },
    { slot: 'argument_count', answer: '1' }, { slot: 'argument_0', answer: 'number' }, { slot: 'number', answer: { value: '1' } }, { slot: 'module_body', answer: 'finish' },
  ]);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: '打印 1 到 10 的数字' } }, 'content', options);
  assert.equal(source, 'print(1)\n');
  assert.ok(!provider.seen.some(s => s.generation.slot === 'unit_count'));
});

test('unit forks record their decision paths in the shared run context', async () => {
  const context = createRunContext();
  const provider = new GateProvider([...decomposition, ...bodies, ...main]);
  await generatePythonAst(new Decisions(provider, 200, new AbortController().signal, undefined, 4, undefined, context), state, 'content', options);

  const greet = context.pathFor(attemptScope('content', 'greet'));
  assert.deepEqual(greet.map(entry => [entry.questionKey, entry.kind]), [['function_body', 'structural'], ['expression', 'structural'], ['string', 'leaf']]);
  assert.ok(greet.every(entry => entry.identity.unit === 'greet' && entry.identity.field === 'content' && entry.identity.phase === 'ast'));
  assert.ok(greet.every(entry => entry.identity.candidate === undefined && entry.chosen.length > 0 && entry.alternatives.length >= 2));

  const shout = context.pathFor(attemptScope('content', 'shout'));
  // shout's single-candidate reference pick is host-derived, so it records no path entry.
  assert.deepEqual(shout.map(entry => [entry.questionKey, entry.kind]), [['function_body', 'structural'], ['expression', 'structural']]);

  const root = context.pathFor(attemptScope('content'));
  assert.ok(root.length >= 10);
  assert.ok(root.every(entry => entry.identity.unit === undefined));

  const ids = [...root, ...greet, ...shout].map(entry => entry.decisionId);
  assert.equal(new Set(ids).size, ids.length, 'decision ids are unique across concurrent unit forks');
  assert.equal(Math.min(...ids), 1);
  await context.dispose();
});

test('regenerating a unit invalidates its previous decision path entries', async () => {
  const context = createRunContext();
  const scope = attemptScope('content', 'greet');
  const run = (): Promise<string> => generatePythonAst(
    new Decisions(new GateProvider([...decomposition, ...bodies, ...main]), 200, new AbortController().signal, undefined, 4, undefined, context),
    state, 'content', options);
  await run();
  const first = context.pathFor(scope).map(entry => entry.decisionId);
  assert.equal(first.length, 3);
  await run();
  const second = context.pathFor(scope);
  assert.equal(second.length, 3);
  assert.ok(second.every(entry => !first.includes(entry.decisionId)));
  for (const id of first) assert.equal(context.decisionEntry(id), undefined, 'invalidated entries are no longer resolvable');
  await context.dispose();
});
