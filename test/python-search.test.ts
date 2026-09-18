import assert from 'node:assert/strict';
import test from 'node:test';
import { Decisions } from '../src/decisions.js';
import { checkCandidate, generatePythonAst } from '../src/python-ast.js';
import { wantsReturn } from '../src/python-search.js';
import type { DecisionProvider } from '../src/types.js';
import { SlotProvider, type SlotEntry } from './helpers.js';

const options = { maxSteps: 200, maxBytes: 8000, allowEmpty: false, fragments: [] };
const decisions = (provider: DecisionProvider, max = 200) => new Decisions(provider, max, new AbortController().signal);
const prompt = 'Write a Python helper get_greeting(name) that returns the greeting text, then print it.';
const state = { task: { prompt, turn: 1, updates: [] } };
const decomposition: SlotEntry[] = [
  { slot: 'unit_count', answer: '1' },
  { slot: 'unit_0_name', answer: { value: 'get_greeting' } }, { slot: 'unit_0_arity', answer: '1' }, { slot: 'unit_0_purpose', answer: { value: 'returns the greeting' } }, { slot: 'unit_0_parameter_0', answer: { value: 'name' } },
];
const unit = 'get_greeting';
const returnString: SlotEntry[] = [{ unit, slot: 'function_body', answer: 'return' }, { unit, slot: 'expression', answer: 'string' }, { unit, slot: 'string', answer: { value: 'greeting' } }];
const main: SlotEntry[] = [
  { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' }, once: true }, { slot: 'argument_count', answer: '1' },
  { slot: 'argument_0', answer: 'call', once: true }, { slot: 'callee', answer: { value: unit } }, { slot: 'argument_0', answer: 'string' }, { slot: 'string', answer: { value: 'name' } },
  { slot: 'module_body', answer: 'finish' },
];
const withCandidate = (candidate: number, entries: SlotEntry[]): SlotEntry[] => entries.map(e => ({ ...e, candidate }));
type Progress = { decoder: string; ast?: { unit?: string; candidate?: number; kept?: boolean; reason?: string } };

test('search width 1 issues exactly the same request sequence as search disabled', async () => {
  const script = [...decomposition, ...returnString, ...main];
  const plain = new SlotProvider(script), one = new SlotProvider(script);
  const a = await generatePythonAst(decisions(plain), state, 'content', options);
  const b = await generatePythonAst(decisions(one), state, 'content', { ...options, searchWidth: 1 });
  assert.equal(a, b);
  assert.deepEqual(one.states.map(s => s.generation?.slot), plain.states.map(s => s.generation?.slot));
  assert.ok(one.states.every(s => s.generation?.candidate === undefined));
});

test('width 3 drops a returnless candidate, scores the survivors, keeps the best and journals every outcome', async () => {
  const provider = new SlotProvider([...decomposition,
    ...withCandidate(0, returnString),
    ...withCandidate(1, [{ unit, slot: 'function_body', answer: 'pass', once: true }, { unit, slot: 'function_body', answer: 'finish' }]),
    ...withCandidate(2, [{ unit, slot: 'function_body', answer: 'return' }, { unit, slot: 'expression', answer: 'name' }, { unit, slot: 'reference', answer: 'name_0' }]),
    { slot: 'candidate_score', candidate: 0, answer: { score: 3 } }, { slot: 'candidate_score', candidate: 2, answer: { score: 2 } },
    ...main]);
  const events: Array<{ text: string; progress: Progress }> = [];
  const d = decisions(provider);
  const source = await generatePythonAst(d, state, 'content', { ...options, searchWidth: 3, onText: async (_f, text, _d, _c, progress) => { events.push({ text, progress: progress as Progress }); } });
  assert.equal(source, "def get_greeting(name):\n    return 'greeting'\nprint(get_greeting('name'))\n");
  const search = events.filter(e => e.progress.decoder === 'search').map(e => e.progress.ast!);
  assert.deepEqual(search.map(a => [a.candidate, a.kept, a.reason]), [[0, true, undefined], [1, false, 'return'], [2, false, undefined]]);
  assert.ok(search.every(a => a.unit === unit));
  assert.match(events.find(e => e.progress.decoder === 'search' && e.progress.ast?.candidate === 1)!.text, /def get_greeting\(name\):\n    pass/);
  const scored = provider.states.filter(s => s.generation?.slot === 'candidate_score');
  assert.deepEqual(scored.map(s => s.generation?.candidate).sort(), [0, 2]);
  assert.equal(d.requests, provider.calls);
  assert.ok(d.requests > 12, `candidates and scores counted: ${d.requests}`);
});

test('every candidate dropped fails the unit with the reasons and produces no source', async () => {
  const provider = new SlotProvider([...decomposition,
    { unit, slot: 'function_body', answer: 'pass', once: true }, { unit, slot: 'function_body', answer: 'pass', once: true }, { unit, slot: 'function_body', answer: 'finish' }]);
  const done: boolean[] = [];
  await assert.rejects(generatePythonAst(decisions(provider), state, 'content', { ...options, searchWidth: 2, onText: async (_f, _t, d) => { done.push(d); } }), /every search candidate was dropped.*return, return/);
  assert.ok(!done.includes(true));
});

test('static checks report compile, undefined, arity and return in that order', async () => {
  const signal = new AbortController().signal;
  const spec = { name: 'f', params: ['x'], peers: { g: 2 }, wantsReturn: true };
  assert.equal(await checkCandidate('def f(x:\n    return x\n', spec, signal), 'compile');
  assert.equal(await checkCandidate('def f(x):\n    return y\n', spec, signal), 'undefined');
  assert.equal(await checkCandidate('def f(x):\n    return g(x)\n', spec, signal), 'arity');
  assert.equal(await checkCandidate('def f(x):\n    g(x, x)\n', spec, signal), 'return');
  assert.equal(await checkCandidate('def f(x):\n    return g(x, x)\n', spec, signal), undefined);
  assert.equal(await checkCandidate('def f(x):\n    print(x)\n', { ...spec, wantsReturn: false }, signal), undefined);
  assert.equal(wantsReturn('returns the greeting'), true);
  assert.equal(wantsReturn('print the board'), false);
});
