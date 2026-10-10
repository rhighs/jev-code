import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Decisions } from '../src/decisions.js';
import { createBuilder, generatePythonAst, repairPythonFailure, vocabulary, type Shared } from '../src/python-ast.js';
import { functionDef, node, type Builder, type PythonNode, type Scope } from '../src/python-nodes.js';
import { attributeFailure, commitRepairedUnit, dependentNames, decodedAnswer, fillUnits, forcedLabels, loadUnitCache, saveUnitCache, unitFromCached, unitToCached, type Unit, type UnitCacheEntry, type UnitCheck, type UnitRepair } from '../src/python-units.js';
import { attemptScope, createRunContext, type RunContext } from '../src/run-context.js';
import { LimitError, type DecisionEventData, type DecisionProvider } from '../src/types.js';
import { SlotProvider, type SlotEntry } from './helpers.js';

interface UnitState { generation: { slot: string; unit?: string; peers?: Array<{ name: string; arity: number; purpose: string }>; partialSource: string; repair?: { reason: string; symbol?: string; snippet?: string } } }
type Hold = (state: UnitState, signal?: AbortSignal) => Promise<void> | void;

class GateProvider implements DecisionProvider {
  readonly inner: SlotProvider;
  readonly seen: UnitState[] = [];
  readonly criteria: Array<{ slot: string; unit?: string; keys: string[] }> = [];
  /** Question keys per request, so wave batching is observable. */
  readonly asked: string[][] = [];
  pending = 0;
  maxPending = 0;
  constructor(script: SlotEntry[], private readonly hold?: Hold) { this.inner = new SlotProvider(script); }
  async decide<Q extends Questions>(input: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    const state = input as unknown as UnitState;
    this.seen.push(structuredClone(state));
    this.asked.push(Object.keys(questions).map(key => key === 'selection' && state.generation.slot !== undefined ? state.generation.slot : key));
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === 'choice') this.criteria.push({ slot: state.generation.slot ?? key, ...(state.generation.unit === undefined ? {} : { unit: state.generation.unit }), keys: Object.keys(question.criteria) });
    }
    this.pending++;
    this.maxPending = Math.max(this.maxPending, this.pending);
    try { await this.hold?.(state, signal); return await this.inner.decide(input, questions, signal); }
    finally { this.pending--; }
  }
}

const options = { maxSteps: 200, maxBytes: 8000, allowEmpty: false, fragments: [] };
// Each test gets its own run context so within-run unit reuse cannot leak between tests.
const decisions = (provider: DecisionProvider, max = 200) => new Decisions(provider, max, new AbortController().signal, undefined, 4, undefined, createRunContext());
const inContext = (provider: DecisionProvider, context: RunContext): Decisions => new Decisions(provider, 200, new AbortController().signal, undefined, 4, undefined, context);
const prompt = 'Write Python helper functions greet(name) and shout(name), then print greet.';
const state = { task: { prompt, turn: 1, updates: [] } };
const decomposition: SlotEntry[] = [
  { slot: 'unit_count', answer: '2' },
  { slot: 'unit_0_name', answer: { value: 'greet' } }, { slot: 'unit_0_arity', answer: '1' }, { slot: 'unit_0_purpose', answer: { value: 'greet' } }, { slot: 'unit_0_parameter_0', answer: { value: 'name' } },
  { slot: 'unit_1_name', answer: { value: 'shout' } }, { slot: 'unit_1_arity', answer: '1' }, { slot: 'unit_1_purpose', answer: { value: 'shout' } }, { slot: 'unit_1_parameter_0', answer: { value: 'name' } },
];
const bodies: SlotEntry[] = [
  { unit: 'greet', slot: 'function_body', answer: 'return' }, { unit: 'greet', slot: 'expression', answer: 'string' }, { unit: 'greet', slot: 'string', answer: { value: 'greet' }, runnerUp: 'shout' },
  { unit: 'shout', slot: 'function_body', answer: 'return' }, { unit: 'shout', slot: 'expression', answer: 'name' }, { unit: 'shout', slot: 'reference', answer: 'name_0' },
];
/** The same fixture with confident (non-near-tie) distributions: repair must skip its alternatives. */
const confident = (script: SlotEntry[]): SlotEntry[] => script.map(entry => {
  const copy: SlotEntry = { ...entry };
  delete copy.runnerUp;
  return copy;
});
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

test('the main block of a unit tree narrows module member arguments and derives the member count', async () => {
  const provider = new GateProvider([
    ...decomposition,
    ...bodies,
    { slot: 'module_body', answer: 'import', once: true },
    { slot: 'module', answer: 'random' },
    { slot: 'module_body', answer: 'expr', once: true },
    { slot: 'expression', answer: 'call' },
    { slot: 'callee', answer: { value: 'print' }, once: true },
    { slot: 'argument_count', answer: '1' },
    { slot: 'argument_0', answer: 'call', once: true },
    { slot: 'callee', answer: 'member' },
    { slot: 'receiver', answer: { value: 'random' } },
    { slot: 'member', answer: 'randint' },
    { slot: 'argument_0', answer: 'number' },
    { slot: 'number', answer: { value: '1' }, once: true },
    { slot: 'argument_1', answer: 'number' },
    { slot: 'number', answer: { value: '10' }, once: true },
    { slot: 'module_body', answer: 'finish' },
  ]);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Write Python helper functions greet(name) and shout(name), then print random.randint(1, 10).', turn: 1, updates: [] } }, 'content', options);
  assert.match(source, /^import random\n/);
  assert.match(source, /print\(random\.randint\(1, 10\)\)\n$/);
  const member = provider.criteria.findIndex(entry => entry.slot === 'member');
  assert.ok(member >= 0, 'the member pick asks instead of spelling');
  assert.ok(provider.criteria[member]!.keys.includes('randint'));
  const args = provider.criteria.slice(member).filter(entry => /^argument_[01]$/.test(entry.slot));
  assert.equal(args.length, 2);
  for (const arg of args) {
    assert.ok(arg.keys.includes('number'));
    assert.ok(!arg.keys.includes('boolean'), 'None is not offered for a number parameter');
    assert.ok(!arg.keys.includes('string'));
  }
  assert.equal(provider.criteria.filter(entry => entry.slot === 'argument_count').length, 1, 'the randint count is host-derived; only print asks');
  assert.ok(!provider.criteria.some(entry => entry.slot === 'method_name'));
});

test('the unit spec batches name, arity, and purpose into one wave per unit, then params', async () => {
  const context = createRunContext();
  const events: DecisionEventData[] = [];
  const provider = new GateProvider([...decomposition, ...bodies, ...main]);
  const d = new Decisions(provider, 200, new AbortController().signal, async data => { events.push(data); }, 4, undefined, context);
  await generatePythonAst(d, state, 'content', options);

  assert.deepEqual(provider.asked.filter(keys => keys.length > 1), [
    ['unit_0_name', 'unit_0_arity', 'unit_0_purpose'],
    ['unit_1_name', 'unit_1_arity', 'unit_1_purpose'],
  ], 'one wave per unit spec; params stay sequential');
  const spec = events.filter(event => event.wave !== undefined && String(event.slot).startsWith('unit_0_'));
  assert.deepEqual(spec.map(event => event.slot), ['unit_0_name', 'unit_0_arity', 'unit_0_purpose']);
  assert.equal(new Set(spec.map(event => event.wave)).size, 1, 'the unit spec is one request');
  assert.equal(new Set(spec.map(event => event.decisionId)).size, 3, 'each wave question gets its own decision id');
  assert.ok(spec.every(event => event.unit === undefined && event.field === 'content' && event.phase === 'ast'));

  const root = context.pathFor(attemptScope('content'));
  assert.deepEqual(root.slice(0, 8).map(entry => [entry.questionKey, entry.kind]), [
    ['unit_count', 'structural'],
    ['unit_0_name', 'leaf'], ['unit_0_arity', 'structural'], ['unit_0_purpose', 'leaf'],
    ['unit_0_parameter_0', 'leaf'],
    ['unit_1_name', 'leaf'], ['unit_1_arity', 'structural'], ['unit_1_purpose', 'leaf'],
  ]);
  await context.dispose();
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
  assert.deepEqual(provider.asked, [['unit_count'], ['unit_0_name', 'unit_0_arity', 'unit_0_purpose'], ['unit_0_parameter_0'],
    ['function_body'], ['function_body'], ['expression'], ['string'],
    ['module_body'], ['expression'], ['callee'], ['argument_count'], ['argument_0'], ['string'], ['module_body']],
  'the unit spec batches into one wave and the retry costs only its own productions');
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
  // A two-arrival barrier guarantees overlap without a timing-dependent sleep.
  let arrived = 0, release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  // Each unit's first body question matches its own scripted `pass`; later questions fall through
  // to the shared `finish`, so a concurrent second question cannot steal another unit's entry.
  const provider = new GateProvider([...units, ...names.map(n => ({ unit: n, slot: 'function_body', answer: 'pass', once: true })), { slot: 'function_body', answer: 'finish' },
    { slot: 'module_body', answer: 'finish' }], async s => {
    if (!s.generation.unit) return;
    if (++arrived === 2) release();
    await both;
  });
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
  const run = (turn = 1, updates: string[] = []): Promise<string> => generatePythonAst(
    new Decisions(new GateProvider([...decomposition, ...bodies, ...main]), 200, new AbortController().signal, undefined, 4, undefined, context),
    { task: { prompt, turn, updates } }, 'content', options);
  await run();
  const first = context.pathFor(scope).map(entry => entry.decisionId);
  assert.equal(first.length, 3);
  // A changed task text clears the reuse cache, so the unit is regenerated with a fresh path.
  await run(2, ['Rewrite both helpers.']);
  const second = context.pathFor(scope);
  assert.equal(second.length, 3);
  assert.ok(second.every(entry => !first.includes(entry.decisionId)));
  for (const id of first) assert.equal(context.decisionEntry(id), undefined, 'invalidated entries are no longer resolvable');
  await context.dispose();
});

const returnsString = (name: string): SlotEntry[] => [
  { unit: name, slot: 'function_body', answer: 'return' }, { unit: name, slot: 'expression', answer: 'string' }, { unit: name, slot: 'string', answer: { value: name } },
];

test('a second write to the same path reuses validated units with no requests for them', async () => {
  const context = createRunContext();
  const first = new GateProvider([...decomposition, ...bodies, ...main]);
  const source = await generatePythonAst(inContext(first, context), { ...state, argumentsSoFar: { path: 'main.py' } }, 'content', options);

  const second = new GateProvider([...main]);
  const again = await generatePythonAst(inContext(second, context), { ...state, argumentsSoFar: { path: 'main.py' } }, 'content', options);
  assert.equal(again, source);
  assert.deepEqual(second.seen.map(entry => entry.generation.slot), ['module_body', 'expression', 'callee', 'argument_count', 'argument_0', 'callee', 'argument_0', 'string', 'module_body']);
  assert.ok(second.seen.every(entry => entry.generation.unit === undefined), 'no unit decisions are asked on reuse');
  assert.equal(second.criteria.length, main.length, 'only the main block asks');

  const entry = loadUnitCache(context, 'main.py', prompt)!;
  assert.deepEqual(entry.units.map(unit => [unit.name, unit.body !== undefined]), [['greet', true], ['shout', true]]);
  await context.dispose();
});

test('a changed task text clears the cached units and regenerates the whole tree', async () => {
  const context = createRunContext();
  const first = new GateProvider([...decomposition, ...bodies, ...main]);
  await generatePythonAst(inContext(first, context), { ...state, argumentsSoFar: { path: 'main.py' } }, 'content', options);
  assert.equal((context.units.get('main.py') as UnitCacheEntry | undefined)?.task, prompt);

  const changed = 'Write Python helper functions greet(name) and shout(name), then print a different greeting.';
  const second = new GateProvider([...decomposition, ...bodies, ...main]);
  await generatePythonAst(inContext(second, context), { task: { prompt: changed, turn: 2, updates: [] }, argumentsSoFar: { path: 'main.py' } }, 'content', options);
  assert.ok(second.seen.some(entry => entry.generation.slot === 'unit_count'), 'the changed task regenerates the decomposition');
  assert.ok(second.seen.some(entry => entry.generation.unit === 'greet' && entry.generation.slot === 'function_body'), 'unit bodies regenerate');
  assert.equal((context.units.get('main.py') as UnitCacheEntry | undefined)?.task, changed, 'the entry now holds the new task text');
  assert.equal(loadUnitCache(context, 'main.py', prompt), undefined, 'a lookup for another task clears the entry');
  assert.equal(context.units.has('main.py'), false);
  await context.dispose();
});

test('whitespace-only task edits keep the cached units', async () => {
  const context = createRunContext();
  const first = new GateProvider([...decomposition, ...bodies, ...main]);
  await generatePythonAst(inContext(first, context), { ...state, argumentsSoFar: { path: 'main.py' } }, 'content', options);

  const second = new GateProvider([...main]);
  const cosmetic = `  ${prompt.replace(' ', '   ')}  `;
  await generatePythonAst(inContext(second, context), { task: { prompt: cosmetic, turn: 1, updates: [] }, argumentsSoFar: { path: 'main.py' } }, 'content', options);
  assert.ok(!second.seen.some(entry => entry.generation.unit === 'greet'), 'cosmetic whitespace keeps reuse');
  await context.dispose();
});

test('a cached unit that fails revalidation is regenerated instead of reused', async () => {
  const context = createRunContext();
  const first = new GateProvider([...decomposition, ...bodies, ...main]);
  await generatePythonAst(inContext(first, context), { ...state, argumentsSoFar: { path: 'main.py' } }, 'content', options);

  const entry = loadUnitCache(context, 'main.py', prompt)!;
  entry.units.find(unit => unit.name === 'greet')!.body = [node('Return', { value: node('Name', { id: 'missing', ctx: node('Load') }) })];

  const second = new GateProvider([...bodies.filter(item => item.unit === 'greet'), ...main]);
  const source = await generatePythonAst(inContext(second, context), { ...state, argumentsSoFar: { path: 'main.py' } }, 'content', options);
  assert.ok(second.seen.some(entry => entry.generation.unit === 'greet' && entry.generation.slot === 'function_body'), 'the invalid cached unit is regenerated');
  assert.ok(!second.seen.some(entry => entry.generation.unit === 'shout'), 'the valid cached unit is reused');
  assert.match(source, /def greet\(name\):\n    return 'greet'/);
  await context.dispose();
});

test('a committed repair invalidates the units that call or are called by the repaired unit', async () => {
  const context = createRunContext();
  const call = (id: string): PythonNode[] => [node('Expr', { value: node('Call', { func: node('Name', { id, ctx: node('Load') }), args: [], keywords: [] }) })];
  const synthetic = (name: string, body: PythonNode[]): Unit => ({ name, arity: 0, purpose: name, params: [], def: functionDef(name, [], body), body });
  const caller = synthetic('caller', call('repaired'));
  const repaired = synthetic('repaired', call('helper'));
  const helper = synthetic('helper', []);
  const unrelated = synthetic('unrelated', []);
  const units = [caller, repaired, helper, unrelated];
  saveUnitCache(context, 'main.py', { task: 'task text', units: units.map(unit => unitToCached(unit, true)) });

  assert.deepEqual(dependentNames(repaired, units), ['caller', 'helper'], 'callers and callees are both dependents');
  assert.deepEqual(commitRepairedUnit(context, 'main.py', repaired, units), ['caller', 'helper']);
  const entry = loadUnitCache(context, 'main.py', 'task text')!;
  const bodyOf = (name: string) => entry.units.find(unit => unit.name === name)!.body;
  assert.notEqual(bodyOf('repaired'), undefined, 'the repaired body is committed to the cache');
  assert.equal(bodyOf('caller'), undefined, 'the caller is invalidated');
  assert.equal(bodyOf('helper'), undefined, 'the callee is invalidated');
  assert.notEqual(bodyOf('unrelated'), undefined, 'unrelated units stay validated');
  assert.deepEqual(commitRepairedUnit(context, 'other.py', repaired, units), [], 'no entry means no invalidation');
  await context.dispose();
});

test('a failed write keeps its validated units and the rewrite regenerates only the failed unit', async () => {
  const context = createRunContext();
  let greetDone!: () => void;
  const greetFinished = new Promise<void>(resolve => { greetDone = resolve; });
  const first = new SlotProvider([...decomposition, ...bodies.filter(item => item.unit === 'greet'), ...main]);
  const failing: DecisionProvider = {
    decide: async <Q extends Questions>(input: EntryType, questions: Q, signal?: AbortSignal) => {
      const generation = (input as unknown as UnitState).generation;
      if (generation.unit === 'shout') { await greetFinished; throw new Error('provider exploded'); }
      const result = await first.decide(input, questions, signal);
      if (generation.unit === 'greet' && generation.slot === 'string') greetDone();
      return result;
    },
  };
  await assert.rejects(generatePythonAst(inContext(failing, context), { ...state, argumentsSoFar: { path: 'main.py' } }, 'content', options), /provider exploded/);

  const entry = loadUnitCache(context, 'main.py', prompt)!;
  assert.deepEqual(entry.units.map(unit => [unit.name, unit.body !== undefined]), [['greet', true], ['shout', false]], 'the validated unit survives the failed write');

  const second = new GateProvider([...bodies.filter(item => item.unit === 'shout'), ...main]);
  const source = await generatePythonAst(inContext(second, context), { ...state, argumentsSoFar: { path: 'main.py' } }, 'content', options);
  assert.ok(!second.seen.some(entry => entry.generation.slot === 'unit_count'), 'the rewrite skips decomposition');
  assert.ok(!second.seen.some(entry => entry.generation.unit === 'greet'), 'the validated unit is reused');
  assert.ok(second.seen.some(entry => entry.generation.unit === 'shout' && entry.generation.slot === 'function_body'), 'the failed unit is regenerated');
  assert.match(source, /def greet\(name\):\n    return 'greet'/);
  assert.match(source, /def shout\(name\):\n    return name/);
  await context.dispose();
});

test('a committed repair makes the next rewrite regenerate the caller and reuse the rest', async () => {
  const context = createRunContext();
  const greetCalls: SlotEntry[] = [
    { unit: 'greet', slot: 'function_body', answer: 'return' }, { unit: 'greet', slot: 'expression', answer: 'call' }, { unit: 'greet', slot: 'callee', answer: { value: 'shout' } },
  ];
  const first = new GateProvider([...decomposition, ...greetCalls, ...returnsString('shout'), ...main]);
  const source = await generatePythonAst(inContext(first, context), { ...state, argumentsSoFar: { path: 'main.py' } }, 'content', options);

  const entry = loadUnitCache(context, 'main.py', prompt)!;
  const units = entry.units.map(unitFromCached);
  assert.deepEqual(commitRepairedUnit(context, 'main.py', units.find(unit => unit.name === 'shout')!, units), ['greet'], 'the caller is invalidated');

  const second = new GateProvider([...greetCalls, ...main]);
  const again = await generatePythonAst(inContext(second, context), { ...state, argumentsSoFar: { path: 'main.py' } }, 'content', options);
  assert.equal(again, source);
  assert.ok(second.seen.some(entry => entry.generation.unit === 'greet'), 'the caller is regenerated');
  assert.ok(!second.seen.some(entry => entry.generation.unit === 'shout'), 'the repaired unit is reused');
  assert.ok(!second.seen.some(entry => entry.generation.slot === 'unit_count'), 'decomposition is skipped');
  await context.dispose();
});

test('assembly records a per-file line-to-slot map and the generated source', async () => {
  const context = createRunContext();
  const provider = new GateProvider([...decomposition, ...bodies, ...main]);
  const source = await generatePythonAst(inContext(provider, context), state, 'content', options);
  assert.equal(context.sourceFor('content'), source);
  const lines = source.split('\n');
  const lineOf = (prefix: string): number => lines.findIndex(line => line.startsWith(prefix)) + 1;
  assert.deepEqual(context.slotAtLine('content', lineOf('def greet(')), { slot: 'function_body', unit: 'greet', scope: attemptScope('content', 'greet'), target: 'content', field: 'content' });
  assert.deepEqual(context.slotAtLine('content', lineOf('def greet(') + 1), { slot: 'function_body', unit: 'greet', scope: attemptScope('content', 'greet'), target: 'content', field: 'content' });
  assert.deepEqual(context.slotAtLine('content', lineOf('def shout(')), { slot: 'function_body', unit: 'shout', scope: attemptScope('content', 'shout'), target: 'content', field: 'content' });
  const moduleSlot = context.slotAtLine('content', lineOf('print('))!;
  assert.equal(moduleSlot.slot, 'module_body');
  assert.equal(moduleSlot.unit, undefined);
  assert.equal(moduleSlot.scope, attemptScope('content'));
  await context.dispose();
});

const traceback = (frames: Array<{ path: string; line: number; source: string }>, error: string): string =>
  ['Traceback (most recent call last):', ...frames.flatMap(frame => [`  File "${frame.path}", line ${frame.line}, in module`, `    ${frame.source}`]), error].join('\n');

test('a unit-body traceback maps to the failing leaf and replay rebuilds the source with no requests', async () => {
  const context = createRunContext();
  const provider = new GateProvider([...decomposition, ...bodies, ...main]);
  const d = inContext(provider, context);
  const source = await generatePythonAst(d, state, 'content', options);
  context.adoptWrittenFile('content', 'main.py');
  const leaf = context.pathFor(attemptScope('content', 'greet')).find(candidate => candidate.kind === 'leaf')!;
  assert.ok(leaf.answer !== undefined && leaf.alternatives.length >= 2);
  assert.equal(leaf.nearTie, true, 'the fixture distribution is a near-tie, so its alternatives are consumable');

  const text = traceback([{ path: '/ws/main.py', line: 3, source: "print(greet('greet'))" }, { path: '/ws/main.py', line: 2, source: "return 'greet'" }], 'TypeError: broken');
  const attribution = attributeFailure(context, text, '/ws');
  assert.ok(attribution, 'the traceback is attributable');
  assert.equal(attribution.unit, 'greet');
  assert.equal(attribution.target, 'content');
  assert.equal(attribution.field, 'content');
  assert.equal(attribution.path, 'main.py');
  assert.equal(attribution.line, 2);
  assert.equal(attribution.decisionId, leaf.decisionId, 'the failing leaf is matched by its answer on the frame line');
  assert.deepEqual(attribution.forced, forcedLabels(leaf));

  const before = provider.inner.calls;
  const repaired = await repairPythonFailure(d, context, attribution, { ...options, context });
  assert.ok(repaired, 'the repair rebuilds the file');
  assert.equal(repaired.outcome.kind, 'unit-replay');
  assert.equal(repaired.outcome.decisionId, leaf.decisionId);
  assert.equal(repaired.outcome.forced, attribution.forced[0]);
  assert.equal(provider.inner.calls, before, 'leaf replay asks no provider questions');
  const expected = JSON.parse(leaf.answers![attribution.forced[0]!]!) as string;
  assert.ok(repaired.files['main.py']!.includes(`return '${expected}'`), `the runner-up literal is replayed: ${expected}`);
  assert.match(repaired.files['main.py']!, /print\(greet\('greet'\)\)/, 'the module path is replayed unchanged');
  assert.equal(context.decisionEntry(leaf.decisionId)?.chosen, attribution.forced[0], 'the used alternative is consumed on commit');
  await context.dispose();
});

test('a module-slot traceback substitutes the failing leaf in the assembled program', async () => {
  const context = createRunContext();
  const provider = new SlotProvider([
    { slot: 'unit_count', answer: '0' },
    { slot: 'module_body', answer: 'expr', once: true },
    { slot: 'expression', answer: 'call' },
    { slot: 'callee', answer: { value: 'print' } },
    { slot: 'argument_count', answer: '1' },
    { slot: 'argument_0', answer: 'binary' },
    { slot: 'operator', answer: 'Div' },
    { slot: 'left', answer: 'number' }, { slot: 'number', answer: { value: 1 }, once: true },
    { slot: 'right', answer: 'number' }, { slot: 'number', answer: { value: 0 }, once: true, runnerUp: 1 },
    { slot: 'module_body', answer: 'finish' },
  ]);
  const d = inContext(provider, context);
  const source = await generatePythonAst(d, { task: { prompt: 'Print a division result.', turn: 1, updates: [] } }, 'content', options);
  assert.equal(source, 'print(1 / 0)\n');
  context.adoptWrittenFile('content', 'main.py');
  const leaf = context.pathFor(attemptScope('content')).filter(candidate => candidate.kind === 'leaf').at(-1)!;
  assert.equal(leaf.nearTie, true, 'the fixture distribution is a near-tie');
  const attribution = attributeFailure(context, traceback([{ path: '/ws/main.py', line: 1, source: 'print(1 / 0)' }], 'ZeroDivisionError: division by zero'), '/ws');
  assert.ok(attribution);
  assert.equal(attribution.unit, undefined, 'the failing frame is a module line');
  assert.equal(attribution.decisionId, leaf.decisionId);

  const before = provider.calls;
  const repaired = await repairPythonFailure(d, context, attribution, { ...options, context });
  assert.ok(repaired);
  assert.equal(repaired.outcome.kind, 'module-substitution');
  assert.equal(repaired.files['main.py'], 'print(1 / 1)\n');
  assert.equal(provider.calls, before, 'module substitution asks no provider questions');
  await context.dispose();
});

test('a non-near-tie failure skips the alternatives and regenerates the unit', async () => {
  const context = createRunContext();
  const provider = new GateProvider([...decomposition, ...confident(bodies), ...main]);
  const d = inContext(provider, context);
  await generatePythonAst(d, state, 'content', options);
  context.adoptWrittenFile('content', 'main.py');
  const leaf = context.pathFor(attemptScope('content', 'greet')).find(candidate => candidate.kind === 'leaf')!;
  assert.equal(leaf.nearTie, false, 'the confident fixture is not a near-tie');
  const attribution = attributeFailure(context, traceback([{ path: '/ws/main.py', line: 3, source: "print(greet('greet'))" }, { path: '/ws/main.py', line: 2, source: "return 'greet'" }], 'TypeError: broken'), '/ws');
  assert.ok(attribution);
  assert.equal(attribution.decisionId, leaf.decisionId);
  assert.ok(attribution.forced.length > 0, 'attribution still reports the runner-ups');

  const before = provider.inner.calls;
  const repaired = await repairPythonFailure(d, context, attribution, { ...options, context });
  assert.ok(repaired);
  assert.equal(repaired.outcome.kind, 'unit-regeneration', 'a confident failure skips the alternatives');
  assert.ok(provider.inner.calls > before, 'the unit regenerates with provider requests');
  assert.ok(repaired.outcome.notes.some(note => /not a near-tie/.test(note)), `skip note: ${JSON.stringify(repaired.outcome.notes)}`);
  assert.match(repaired.files['main.py']!, /def greet\(name\):\n    return 'greet'\n/);
  await context.dispose();
});

test('a non-near-tie module failure regenerates the module block', async () => {
  const context = createRunContext();
  const provider = new SlotProvider([
    { slot: 'unit_count', answer: '0', once: true },
    { slot: 'module_body', answer: 'expr', once: true },
    { slot: 'expression', answer: 'call', once: true },
    { slot: 'callee', answer: { value: 'print' }, once: true },
    { slot: 'argument_count', answer: '1', once: true },
    { slot: 'argument_0', answer: 'binary', once: true },
    { slot: 'operator', answer: 'Div', once: true },
    { slot: 'left', answer: 'number', once: true }, { slot: 'number', answer: { value: 1 }, once: true },
    { slot: 'right', answer: 'number', once: true }, { slot: 'number', answer: { value: 0 }, once: true },
    { slot: 'module_body', answer: 'finish', once: true },
    // Regeneration after the confident failure: a corrected division.
    { slot: 'module_body', answer: 'expr', once: true },
    { slot: 'expression', answer: 'call', once: true },
    { slot: 'callee', answer: { value: 'print' }, once: true },
    { slot: 'argument_count', answer: '1', once: true },
    { slot: 'argument_0', answer: 'binary', once: true },
    { slot: 'operator', answer: 'Div', once: true },
    { slot: 'left', answer: 'number', once: true }, { slot: 'number', answer: { value: 1 }, once: true },
    { slot: 'right', answer: 'number', once: true }, { slot: 'number', answer: { value: 1 }, once: true },
    { slot: 'module_body', answer: 'finish', once: true },
  ]);
  const d = inContext(provider, context);
  const source = await generatePythonAst(d, { task: { prompt: 'Print a division result.', turn: 1, updates: [] } }, 'content', options);
  assert.equal(source, 'print(1 / 0)\n');
  context.adoptWrittenFile('content', 'main.py');
  const leaf = context.pathFor(attemptScope('content')).filter(candidate => candidate.kind === 'leaf').at(-1)!;
  assert.equal(leaf.nearTie, false, 'the confident fixture is not a near-tie');
  const attribution = attributeFailure(context, traceback([{ path: '/ws/main.py', line: 1, source: 'print(1 / 0)' }], 'ZeroDivisionError: division by zero'), '/ws');
  assert.ok(attribution);
  assert.equal(attribution.decisionId, leaf.decisionId);

  const before = provider.calls;
  const repaired = await repairPythonFailure(d, context, attribution, { ...options, context });
  assert.ok(repaired);
  assert.equal(repaired.outcome.kind, 'module-regeneration');
  assert.ok(provider.calls > before, 'the module block regenerates with provider requests');
  assert.equal(repaired.files['main.py'], 'print(1 / 1)\n');
  assert.ok(repaired.outcome.notes.some(note => /not a near-tie/.test(note)), `skip note: ${JSON.stringify(repaired.outcome.notes)}`);
  await context.dispose();
});

test('an exhausted alternative list regenerates the unit once', async () => {
  const context = createRunContext();
  const provider = new GateProvider([...decomposition, ...bodies, ...main]);
  const d = inContext(provider, context);
  await generatePythonAst(d, state, 'content', options);
  context.adoptWrittenFile('content', 'main.py');
  const leaf = context.pathFor(attemptScope('content', 'greet')).find(candidate => candidate.kind === 'leaf')!;
  assert.equal(leaf.nearTie, true, 'the near-tie gate opens the replay loop');

  const attribution = { target: 'content', path: 'content', field: 'content', scope: attemptScope('content', 'greet'), unit: 'greet', decisionId: leaf.decisionId, chosen: leaf.chosen, forced: ['missing_alternative'], reason: 'x' };
  const before = provider.criteria.filter(entry => entry.unit === 'greet' && entry.slot === 'function_body').length;
  const repaired = await repairPythonFailure(d, context, attribution, { ...options, context });
  assert.ok(repaired);
  assert.equal(repaired.outcome.kind, 'unit-regeneration', 'every unusable alternative falls through to one regeneration');
  const after = provider.criteria.filter(entry => entry.unit === 'greet' && entry.slot === 'function_body').length;
  assert.equal(after - before, 1, 'the unit is regenerated exactly once');
  assert.match(repaired.files['content']!, /def greet\(name\):\n    return 'greet'\n/);
  await context.dispose();
});

test('a checker reason without a traceback maps to the recorded leaf by its answer text', async () => {
  const context = createRunContext();
  const provider = new GateProvider([...decomposition, ...bodies, ...main]);
  await generatePythonAst(inContext(provider, context), state, 'content', options);
  const attribution = attributeFailure(context, "main.py printed 'greet' but expected 'hello'", '/ws');
  assert.ok(attribution);
  assert.equal(attribution.unit, 'greet');
  assert.equal(attribution.line, undefined);
  const leaf = context.pathFor(attemptScope('content', 'greet')).find(candidate => candidate.kind === 'leaf')!;
  assert.equal(attribution.decisionId, leaf.decisionId);
  assert.deepEqual(attribution.forced, forcedLabels(leaf));
  await context.dispose();
});

test('unattributable failure text returns undefined', async () => {
  const context = createRunContext();
  const provider = new GateProvider([...decomposition, ...bodies, ...main]);
  await generatePythonAst(inContext(provider, context), state, 'content', options);
  assert.equal(attributeFailure(context, 'command not found: frobnicate', '/ws'), undefined);
  assert.equal(attributeFailure(context, 'Traceback (most recent call last):\n  File "other.py", line 2, in <module>\n    boom\n', '/ws'), undefined);
  await context.dispose();
});

test('a unit path without leaf decisions skips replay and regenerates the narrowest unit', async () => {
  const context = createRunContext();
  const prompt = 'Write a Python helper echo(name) that returns its argument, then print it.';
  const script: SlotEntry[] = [
    { slot: 'unit_count', answer: '1' },
    { slot: 'unit_0_name', answer: { value: 'echo' } }, { slot: 'unit_0_arity', answer: '1' }, { slot: 'unit_0_purpose', answer: { value: 'echo' } }, { slot: 'unit_0_parameter_0', answer: { value: 'name' } },
    { unit: 'echo', slot: 'function_body', answer: 'return' }, { unit: 'echo', slot: 'expression', answer: 'name' },
    { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' }, once: true },
    { slot: 'argument_count', answer: '1' }, { slot: 'argument_0', answer: 'call', once: true }, { slot: 'callee', answer: { value: 'echo' } },
    { slot: 'argument_0', answer: 'string' }, { slot: 'string', answer: { value: 'name' } },
    { slot: 'module_body', answer: 'finish' },
  ];
  const provider = new GateProvider(script);
  const d = inContext(provider, context);
  await generatePythonAst(d, { task: { prompt, turn: 1, updates: [] } }, 'content', options);
  context.adoptWrittenFile('content', 'main.py');
  const unitPath = context.pathFor(attemptScope('content', 'echo'));
  assert.ok(unitPath.length >= 2 && unitPath.every(entry => entry.kind === 'structural'), 'the unit path has no leaf entries');
  const attribution = attributeFailure(context, traceback([{ path: '/ws/main.py', line: 2, source: 'return name' }], 'NameError: name is not defined'), '/ws');
  assert.ok(attribution);
  assert.equal(attribution.unit, 'echo');
  assert.equal(attribution.decisionId, undefined);
  assert.deepEqual(attribution.forced, []);

  const before = provider.inner.calls;
  const repaired = await repairPythonFailure(d, context, attribution, { ...options, context });
  assert.ok(repaired);
  assert.equal(repaired.outcome.kind, 'unit-regeneration');
  assert.ok(provider.inner.calls > before, 'the structural fallback regenerates the failing unit');
  assert.match(repaired.files['main.py']!, /def echo\(name\):\n    return name\n/);
  await context.dispose();
});

test('consuming a repair alternative moves the recorded choice and drops the used label', async () => {
  const context = createRunContext();
  const provider = new GateProvider([...decomposition, ...bodies, ...main]);
  await generatePythonAst(inContext(provider, context), state, 'content', options);
  const entry = context.pathFor(attemptScope('content', 'greet')).find(candidate => candidate.kind === 'leaf')!;
  const forced = forcedLabels(entry)[0]!;
  assert.equal(context.consumeAlternative(entry.decisionId, forced), true);
  const after = context.decisionEntry(entry.decisionId)!;
  assert.equal(after.chosen, forced);
  assert.equal(after.answer, after.answers?.[forced]);
  assert.ok(!after.alternatives.some(alternative => alternative.label === forced), 'the used alternative is dropped');
  assert.equal(context.consumeAlternative(entry.decisionId, forced), false, 'consuming the same label twice is a no-op');
  assert.equal(context.consumeAlternative(999_999, 'value_0'), false, 'unknown decisions are a no-op');
  await context.dispose();
});

test('a validated dropped search candidate is reused when leaf replay is unavailable', async () => {
  const context = createRunContext();
  const prompt = 'Write a Python helper get_greeting(name) that returns the greeting text, then print it.';
  const unit = 'get_greeting';
  const provider = new SlotProvider([
    { slot: 'unit_count', answer: '1' },
    { slot: 'unit_0_name', answer: { value: unit } }, { slot: 'unit_0_arity', answer: '1' }, { slot: 'unit_0_purpose', answer: { value: 'returns the greeting' } }, { slot: 'unit_0_parameter_0', answer: { value: 'name' } },
    { unit, candidate: 0, slot: 'function_body', answer: 'return' }, { unit, candidate: 0, slot: 'expression', answer: 'string' }, { unit, candidate: 0, slot: 'string', answer: { value: 'greeting' } },
    { unit, candidate: 1, slot: 'function_body', answer: 'pass', once: true }, { unit, candidate: 1, slot: 'function_body', answer: 'finish', once: true },
    { unit, candidate: 2, slot: 'function_body', answer: 'return' }, { unit, candidate: 2, slot: 'expression', answer: 'name' }, { unit, candidate: 2, slot: 'reference', answer: 'name_0' },
    { slot: 'candidate_score', candidate: 0, answer: { score: 3 } }, { slot: 'candidate_score', candidate: 2, answer: { score: 2 } },
    { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' }, once: true },
    { slot: 'argument_count', answer: '1' }, { slot: 'argument_0', answer: 'call', once: true }, { slot: 'callee', answer: { value: unit } },
    { slot: 'argument_0', answer: 'string' }, { slot: 'string', answer: { value: 'name' } },
    { slot: 'module_body', answer: 'finish' },
  ]);
  const d = inContext(provider, context);
  await generatePythonAst(d, { task: { prompt, turn: 1, updates: [] } }, 'content', { ...options, searchWidth: 3 });
  assert.equal(context.candidatesFor('content', unit).length, 1);

  const attribution = { target: 'content', path: 'content', field: 'content', scope: attemptScope('content', unit), unit, forced: [] as string[], reason: 'runtime failure with no replayable leaf' };
  const repaired = await repairPythonFailure(d, context, attribution, { ...options, context });
  assert.ok(repaired);
  assert.equal(repaired.outcome.kind, 'candidate-reuse');
  assert.match(repaired.files['content']!, /def get_greeting\(name\):\n    return name\n/);
  await context.dispose();
});

test('an alternative that cannot be replayed is discarded and the next one is used', async () => {
  const context = createRunContext();
  const provider = new GateProvider([...decomposition, ...bodies, ...main]);
  const d = inContext(provider, context);
  await generatePythonAst(d, state, 'content', options);
  const leaf = context.pathFor(attemptScope('content', 'greet')).find(candidate => candidate.kind === 'leaf')!;
  const good = forcedLabels(leaf)[0]!;
  const attribution = { target: 'content', path: 'content', field: 'content', scope: attemptScope('content', 'greet'), unit: 'greet', decisionId: leaf.decisionId, chosen: leaf.chosen, forced: ['not_a_label', good], reason: 'x' };
  const repaired = await repairPythonFailure(d, context, attribution, { ...options, context });
  assert.ok(repaired);
  assert.equal(repaired.outcome.kind, 'unit-replay');
  assert.equal(repaired.outcome.forced, good, 'the invalid alternative is skipped and the next one is used');
  await context.dispose();
});

test('a structural callee failure skips replay and regenerates deterministically', async () => {
  const context = createRunContext();
  const provider = new GateProvider([...decomposition,
    { unit: 'greet', slot: 'function_body', answer: 'return' }, { unit: 'greet', slot: 'expression', answer: 'string' }, { unit: 'greet', slot: 'string', answer: { value: 'greet' } },
    { unit: 'shout', slot: 'function_body', answer: 'return' }, { unit: 'shout', slot: 'expression', answer: 'call' }, { unit: 'shout', slot: 'callee', answer: { value: 'greet' } },
    { unit: 'shout', slot: 'argument_0', answer: 'name' },
    ...main]);
  const d = inContext(provider, context);
  await generatePythonAst(d, state, 'content', options);
  const callee = context.pathFor(attemptScope('content', 'shout')).find(entry => entry.questionKey === 'callee')!;
  assert.equal(callee.kind, 'structural');
  assert.ok(forcedLabels(callee).length > 0, 'the structural decision has runner-ups that must not be replayed');

  const attribution = { target: 'content', path: 'content', field: 'content', scope: attemptScope('content', 'shout'), unit: 'shout', decisionId: callee.decisionId, chosen: callee.chosen, forced: forcedLabels(callee), reason: 'x' };
  const before = provider.inner.calls;
  const repaired = await repairPythonFailure(d, context, attribution, { ...options, context });
  assert.ok(repaired);
  assert.equal(repaired.outcome.kind, 'unit-regeneration', 'a structural override never replays');
  assert.ok(provider.inner.calls > before, 'the structural failure regenerates the unit');
  assert.match(repaired.files['content']!, /def shout\(name\):\n    return greet\(name\)/);
  await context.dispose();
});
