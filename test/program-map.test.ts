import assert from 'node:assert/strict';
import test from 'node:test';
import { Decisions } from '../src/decisions.js';
import { AstRegistry } from '../src/ast-adapters.js';
import { generateArguments, generateText } from '../src/generation.js';
import { generateMappedProgram, parseMap, type ProgramMap } from '../src/program-map.js';
import type { ProposalProvider } from '../src/providers/types.js';
import { SlotProvider } from './helpers.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from '../src/harness.js';
import type { HarnessEvent } from '../src/types.js';

const map: ProgramMap = { goal: 'Print the first ten Fibonacci numbers.', checks: ['Print 0,1,1,2,3,5,8,13,21,34.'], steps: [
  { intent: 'Start the Fibonacci pair', requires: [], provides: ['a', 'b'], options: [{ meaning: 'Start from zero and one', code: 'a, b = 0, 1' }] },
  { intent: 'Print ten values while advancing the pair', requires: ['a', 'b'], provides: [], options: [
    { meaning: 'Print the current value then advance ten times', code: 'for _ in range(10):\n    print(a)\n    a, b = b, a + b' },
    { meaning: 'Use a counter-controlled loop for ten values', code: 'i = 0\nwhile i < 10:\n    print(a)\n    a, b = b, a + b\n    i += 1' },
  ] },
] };
const registry = new AstRegistry();
const adapter = registry.resolve({ argumentsSoFar: { path: 'main.py' } })!;
const options = { maxSteps: 20, maxBytes: 20_000, allowEmpty: false, fragments: [] };
const state = { task: { prompt: 'Write a simple Python Fibonacci program printing the first ten.' }, argumentsSoFar: { path: 'main.py' } };
const generator = (get = () => map): ProposalProvider & { calls: number } => ({ id: 'test', model: 'mapper', calls: 0,
  async generate(req) { this.calls++; assert.equal(req.count, 1); assert.match(req.constraints, /meaningful subproblem/); return [{ text: JSON.stringify(get()), truncated: false }]; } });
const approved = () => new SlotProvider([{ slot: 'review_plan', answer: 'approve' }, { slot: 'choose_step', answer: 'A' }, { slot: 'review_program', answer: 'approve' }]);

test('maps Fibonacci into four meaningful Jev decisions rather than syntax choices', async () => {
  const policy = approved(), gen = generator();
  const d = new Decisions(policy, 20, new AbortController().signal);
  const source = await generateMappedProgram(adapter, d, state, 'content', { ...options, mapper: { provider: gen, budget: { used: 0, max: 3 } } });
  assert.equal(source, 'a, b = 0, 1\nfor _ in range(10):\n    print(a)\n    a, b = b, a + b\n');
  assert.equal(gen.calls, 1);
  assert.equal(d.requests, 4);
  assert.deepEqual(policy.states.map(s => s.generation?.slot), ['review_plan', 'choose_step', 'choose_step', 'review_program']);
});

test('Jev rejects an unnecessary map before selecting any code', async () => {
  const policy = new SlotProvider([{ slot: 'review_plan', answer: 'unnecessary', once: true }, { slot: 'review_plan', answer: 'approve' }, { slot: 'choose_step', answer: 'A' }, { slot: 'review_program', answer: 'approve' }]);
  const gen = generator();
  await generateMappedProgram(adapter, new Decisions(policy, 20, new AbortController().signal), state, 'content', { ...options, mapper: { provider: gen, budget: { used: 0, max: 3 } } });
  assert.equal(gen.calls, 2);
  assert.equal(policy.states[1]?.generation?.slot, 'review_plan');
});

test('an invalid default future piece triggers remapping before selection', async () => {
  const m = structuredClone(map);
  m.steps[1]!.options[0]!.code = 'for : invalid';
  const policy = new SlotProvider([{ slot: 'review_plan', answer: 'approve' }, { slot: 'choose_step', answer: 'A', once: true }, { slot: 'choose_step', answer: 'B' }, { slot: 'review_program', answer: 'approve' }]);
  const gen = generator(() => m);
  await assert.rejects(generateMappedProgram(adapter, new Decisions(policy, 20, new AbortController().signal), state, 'content', { ...options, mapper: { provider: gen, budget: { used: 0, max: 1 } } }), /proposal budget/);
});

test('final program rejection remaps without returning the rejected draft', async () => {
  const policy = new SlotProvider([{ slot: 'review_plan', answer: 'approve' }, { slot: 'choose_step', answer: 'A' }, { slot: 'review_program', answer: 'incorrect', once: true }, { slot: 'review_program', answer: 'approve' }]);
  const gen = generator();
  await generateMappedProgram(adapter, new Decisions(policy, 20, new AbortController().signal), state, 'content', { ...options, mapper: { provider: gen, budget: { used: 0, max: 3 } } });
  assert.equal(gen.calls, 2);
});

test('map schema, code, and retry budgets are bounded', async () => {
  assert.throws(() => parseMap(JSON.stringify({ ...map, steps: Array(9).fill(map.steps[0]) })), /1–8/);
  assert.throws(() => parseMap(JSON.stringify({ ...map, steps: [{ ...map.steps[0], options: [{ meaning: 'x', code: 'x'.repeat(2049) }] }] })), /2048/);
  const gen = generator();
  const d = new Decisions(new SlotProvider([{ slot: 'review_plan', answer: 'incorrect' }]), 20, new AbortController().signal);
  await assert.rejects(generateMappedProgram(adapter, d, state, 'content', { ...options, mapper: { provider: gen, budget: { used: 0, max: 10 } } }), /three mappings/);
  assert.equal(gen.calls, 3);
});

test('exhausted Jev budget prevents paid mapping requests', async () => {
  const gen = generator();
  await assert.rejects(generateMappedProgram(adapter, new Decisions(approved(), 1, new AbortController().signal), state, 'content', { ...options, mapper: { provider: gen, budget: { used: 0, max: 3 } } }), /Request budget/);
  assert.equal(gen.calls, 0);
});

test('provider failure never falls back to the slow grammar', async () => {
  const gen: ProposalProvider = { id: 'test', model: 'mapper', generate: async () => [{ error: 'failed' }] };
  await assert.rejects(generateText(new Decisions(approved(), 20, new AbortController().signal), state, 'content', 'source', { ...options, mapper: { provider: gen, budget: { used: 0, max: 3 } } }), /mapping provider failed/);
});

test('write_file routes the resolved path before requesting a program map', async () => {
  const policy = new SlotProvider([{ slot: 'selection', answer: 'plan_0' }, { slot: 'review_plan', answer: 'approve' }, { slot: 'choose_step', answer: 'A' }, { slot: 'review_program', answer: 'approve' }]);
  const gen = generator();
  const args = await generateArguments(new Decisions(policy, 20, new AbortController().signal), { task: { prompt: 'Write main.py in Python.' }, action: 'write_file' },
    { path: { type: 'string', description: 'path' }, content: { type: 'string', description: 'content' } }, { maxSteps: 20, fragments: [], mapper: { provider: gen, budget: { used: 0, max: 3 } } });
  assert.equal(args.path, 'main.py');
  assert.match(String(args.content), /range\(10\)/);
  assert.equal(gen.calls, 1);
});

test('harness writes only the approved program and journals mapped decisions', async t => {
  const ws = await mkdtemp(join(tmpdir(), 'jev-map-test-'));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const policy = new SlotProvider([
    { slot: 'selection', answer: 'write_file', once: true },
    { phase: 'plan', answer: 'plan_0' },
    { slot: 'review_plan', answer: 'approve' }, { slot: 'choose_step', answer: 'A' }, { slot: 'review_program', answer: 'approve' },
    { slot: 'selection', answer: 'finish', once: true }, { slot: 'selection', answer: 'complete' },
  ]);
  const events: HarnessEvent[] = [];
  const result = await new Harness({ workspace: ws, provider: policy, generationProvider: generator(), onEvent: e => { events.push(e); } }).run('Write main.py in Python to print the first ten Fibonacci numbers.');
  assert.equal(result.status, 'completed', result.summary);
  assert.match(await readFile(join(ws, 'main.py'), 'utf8'), /range\(10\)/);
  assert.equal(events.filter(e => e.type === 'decision' && e.data.phase === 'program_map').length, 4);
});

test('an invalid alternative cannot be chosen even if its description sounds correct', async () => {
  const m = structuredClone(map);
  m.steps[1]!.options[1]!.code = 'for : invalid';
  const policy = approved();
  const source = await generateMappedProgram(adapter, new Decisions(policy, 20, new AbortController().signal), state, 'content', { ...options, mapper: { provider: generator(() => m), budget: { used: 0, max: 3 } } });
  assert.match(source, /range\(10\)/);
  const last = policy.states.filter(s => s.generation?.slot === 'choose_step').at(-1) as { generation: { candidates: Array<{ label: string; valid: boolean }> } };
  assert.equal(last.generation.candidates.find(c => c.label === 'B')?.valid, false);
});

test('cancelling the mapper prevents every policy decision and file draft', async () => {
  const ctrl = new AbortController();
  const policy = approved();
  const gen: ProposalProvider = { id: 'test', model: 'mapper', generate: async () => { ctrl.abort(new Error('stop')); return [{ text: JSON.stringify(map), truncated: false }]; } };
  await assert.rejects(generateMappedProgram(adapter, new Decisions(policy, 20, ctrl.signal), state, 'content', { ...options, mapper: { provider: gen, budget: { used: 0, max: 3 } } }), /stop/);
  assert.equal(policy.calls, 0);
});

test('mapping receives bounded recent file context when rewriting an existing file', async () => {
  const gen = generator();
  const generate = gen.generate.bind(gen);
  gen.generate = async (req, signal) => {
    assert.match(req.current!, /a, b = 0, 1/);
    assert.ok(req.current!.length < 4000);
    return generate(req, signal);
  };
  await generateMappedProgram(adapter, new Decisions(approved(), 20, new AbortController().signal), { ...state,
    recent: [{ tool: 'read_file', args: { path: 'main.py' }, result: { ok: true, output: 'a, b = 0, 1\n' + 'x'.repeat(10_000) } }],
  }, 'content', { ...options, mapper: { provider: gen, budget: { used: 0, max: 3 } } });
});

test('write_files maps cross-file work without entering grammar decisions', async () => {
  const project = { goal: 'Print Fibonacci from a reusable module.', checks: ['main.py prints the first ten values.'], steps: [
    { path: 'fib.py', intent: 'Provide the sequence function', requires: [], provides: ['fib.fibonacci'], options: [{ meaning: 'Build a sequence of the requested length', code: 'def fibonacci(n):\n    a, b = 0, 1\n    result = []\n    for _ in range(n):\n        result.append(a)\n        a, b = b, a + b\n    return result' }] },
    { path: 'main.py', intent: 'Print the requested sequence', requires: ['fib.fibonacci'], provides: [], options: [{ meaning: 'Call the reusable function with ten', code: 'from fib import fibonacci\nprint(*fibonacci(10))' }] },
  ] };
  const policy = approved(), gen = generator(() => project);
  const result = await generateText(new Decisions(policy, 20, new AbortController().signal), { task: { prompt: 'Create fib.py and main.py in Python.' }, action: 'write_files' }, 'files', 'manifest', { ...options, mapper: { provider: gen, budget: { used: 0, max: 3 } } });
  const files = JSON.parse(result) as Record<string, string>;
  assert.deepEqual(Object.keys(files), ['fib.py', 'main.py']);
  assert.match(files['main.py']!, /from fib import fibonacci/);
  assert.equal(gen.calls, 1);
  assert.equal(policy.states.some(s => s.generation?.phase === 'ast'), false);
});

test('map steps reject unsafe destination paths before compilation', () => {
  const unsafe = structuredClone(map);
  Object.assign(unsafe.steps[0]!, { path: '../outside.py' });
  assert.throws(() => parseMap(JSON.stringify(unsafe)), /path/i);
});

test('mapped rewrites load the actual destination source and scope the generator to its final contents', async () => {
  let seen = false;
  const source = 'a, b = 0, 1\n';
  const gen: ProposalProvider = { id: 'test', model: 'test', generate: async req => {
    const context = JSON.parse(req.current!);
    assert.equal(context.observations.existingSource, source);
    assert.equal(context.observations.arguments.path, 'main.py');
    assert.match(req.constraints, /actual final contents of the destination/);
    seen = true;
    return [{ text: JSON.stringify(map), truncated: false }];
  } };
  await generateMappedProgram(adapter, new Decisions(approved(), 20, new AbortController().signal), state, 'content', {
    ...options, mapper: { provider: gen, budget: { used: 0, max: 1 }, readSource: async path => { assert.equal(path, 'main.py'); return source; } },
  });
  assert.equal(seen, true);
});
