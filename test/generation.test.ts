import assert from 'node:assert/strict';
import test from 'node:test';
import { AstRegistry, type AstAdapter } from '../src/ast-adapters.js';
import { Decisions } from '../src/decisions.js';
import { generateArguments, generateText, syntaxFeedback } from '../src/generation.js';
import { characterAlphabet } from '../src/grid.js';
import { generateProgram } from '../src/lang/core.js';
import { typescriptDialect } from '../src/lang/javascript.js';
import type { DecisionProvider } from '../src/types.js';
import { ScriptedProvider } from './helpers.js';

test('character alphabet includes whitespace, observed Unicode and END without snippet templates', () => {
  const alphabet = characterAlphabet(['🌍é']);
  for (const symbol of alphabet) assert.equal([...symbol.value].length, symbol.key === 'END' ? 0 : 1);
  assert.equal(new Set(alphabet.map(symbol => symbol.key)).size, alphabet.length);
  for (const value of ['🌍', 'é', ' ', '\n', '\t', '\r', '']) assert.ok(alphabet.some(symbol => symbol.value === value));
});

test('all text argument grids generate concurrently and preserve arbitrary whitespace', async () => {
  const provider = new ScriptedProvider([{ action: 'write_file', args: { path: 'sum.ts', content: 'export const value = 42;\n' } }]);
  const active = new Set<string>();
  let overlap = false;
  const args = await generateArguments(new Decisions(provider, 100, new AbortController().signal), {
    task: { turn: 1, prompt: 'Create sum.ts.', updates: [] }, action: 'write_file',
  }, { path: { type: 'string', description: 'Path.' }, content: { type: 'string', description: 'Contents.' } }, {
    experimentalGrid: true, fragments: [], maxSteps: 64, gridBatchSize: 8, concurrency: 4, astRegistry: new AstRegistry([], false),
    onText: async (field, _value, done) => { active.add(field); if (active.size > 1) overlap = true; if (done) active.delete(field); },
  });
  assert.deepEqual(args, { path: 'sum.ts', content: 'export const value = 42;\n' });
  assert.equal(overlap, true);
  assert.deepEqual(syntaxFeedback({ argumentsSoFar: args }, 'content', String(args.content)), []);
});

test('grid can generate an intentional empty field without dropping ordinary content', async () => {
  const provider = new ScriptedProvider([{ action: 'write_file', args: { content: '' } }]);
  const actual = await generateText(new Decisions(provider, 100, new AbortController().signal), {
    task: { turn: 1, prompt: 'Create an empty file.', updates: [] }, action: 'write_file',
  }, 'content', 'Exact contents.', { fragments: [], maxSteps: 8, maxBytes: 100, allowEmpty: true });
  assert.equal(actual, '');
});

test('unavailable model choices fail instead of silently decoding arbitrary output', async () => {
  const provider: DecisionProvider = { decide: async () => ({ model: 'bad', usage: { input_tokens: 0, output_tokens: 0 },
    answers: { selection: { type: 'choice', choice: 'not-an-option', confidence: 1, probabilities: {} } } } as never) };
  await assert.rejects(new Decisions(provider, 20, new AbortController().signal).choose({}, 'Choose.', { a: 'A.', b: 'B.' }), /unavailable choice/);
});

test('structured path tokens never repeat the span just appended', async () => {
  const provider: DecisionProvider = { decide: async (_input, questions) => {
    const q = questions.selection;
    if (!q || q.type !== 'choice') throw new Error('Expected a choice question.');
    const span = Object.entries(q.criteria).find(([, v]) => v === JSON.stringify('main.py'))?.[0];
    const choice = span ?? (Object.hasOwn(q.criteria, 'plan_0') ? 'free' : 'END');
    return { model: 't', usage: { input_tokens: 0, output_tokens: 0 }, answers: { selection: { type: 'choice', choice, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === choice ? 1 : 0])) } } } as never;
  } };
  const actual = await generateText(new Decisions(provider, 100, new AbortController().signal), {
    task: { turn: 1, prompt: 'write a program that prints numbers from 1 to 10', updates: [] }, action: 'write_file',
  }, 'path', 'Destination file path.', { fragments: [], maxSteps: 32, maxBytes: 256, allowEmpty: false });
  assert.equal(actual, 'main.py');
});

test('a path plan offers conventional filenames when the task names no file or language', async () => {
  let offered: string[] = [];
  const provider: DecisionProvider = { decide: async (_input, questions) => {
    const q = questions.selection;
    if (!q || q.type !== 'choice') throw new Error('Expected a choice question.');
    offered = Object.values(q.criteria).filter((v): v is string => typeof v === 'string');
    return { model: 't', usage: { input_tokens: 0, output_tokens: 0 }, answers: { selection: { type: 'choice', choice: 'plan_1', confidence: 1,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === 'plan_1' ? 1 : 0])) } } } as never;
  } };
  const actual = await generateText(new Decisions(provider, 100, new AbortController().signal), {
    task: { turn: 1, prompt: 'write a program that prints numbers from 1 to 10', updates: [] }, action: 'write_file',
  }, 'path', 'Destination file path.', { fragments: [], maxSteps: 32, maxBytes: 256, allowEmpty: false });
  assert.equal(actual, 'main.ts');
  assert.ok(offered.includes(JSON.stringify('main.py')));
});

test('a read path plan offers workspace files instead of default program names', async () => {
  let offered: string[] = [];
  const provider: DecisionProvider = { decide: async (_input, questions) => {
    const q = questions.selection;
    if (!q || q.type !== 'choice') throw new Error('Expected a choice question.');
    offered = Object.values(q.criteria).filter((v): v is string => typeof v === 'string');
    return { model: 't', usage: { input_tokens: 0, output_tokens: 0 }, answers: { selection: { type: 'choice', choice: 'plan_1', confidence: 1,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === 'plan_1' ? 1 : 0])) } } } as never;
  } };
  const actual = await generateText(new Decisions(provider, 100, new AbortController().signal), {
    task: { turn: 1, prompt: 'what happened exactly?', updates: [] }, action: 'read_file', workspace: { root: '/w', files: ['notes.md', 'main.ts'] },
  }, 'path', 'File path to read.', { fragments: [], maxSteps: 32, maxBytes: 256, allowEmpty: false });
  assert.equal(actual, 'main.ts');
  assert.ok(!offered.includes(JSON.stringify('main.py')));
  assert.ok(offered.includes(JSON.stringify('notes.md')));
});

const adapterFor = (id: string, extension: string, generate: () => string, validate: (source: string) => void): AstAdapter => ({
  id, extensions: [extension], languages: [id],
  async generate() { return generate(); },
  async validate(source) { validate(source); },
});

const contentState = (path: string) => ({ task: { turn: 1, prompt: `Create ${path}.`, updates: [] }, action: 'write_file', argumentsSoFar: { path } });
const contentOptions = (registry: AstRegistry) => ({ fragments: [], maxSteps: 8, maxBytes: 100, allowEmpty: false, astRegistry: registry });

test('a JS/TS validation failure retries once with the diagnostics in state and accepts the retry', async () => {
  let calls = 0;
  const states: Array<{ generation?: { syntax?: unknown; reason?: unknown } }> = [];
  const adapter: AstAdapter = {
    id: 'typescript', extensions: ['.ts'], languages: ['typescript'],
    async generate(_decisions, state) { states.push(state as never); calls++; return calls === 1 ? 'f(1 2);\n' : 'const value = 1;\n'; },
    async validate(source) { if (source !== 'const value = 1;\n') throw new Error("',' expected."); },
  };
  const registry = new AstRegistry([adapter], false);
  const actual = await generateText(new Decisions(new ScriptedProvider([{ action: 'write_file', args: { path: 'main.ts', content: 'const value = 1;\n' } }]), 100, new AbortController().signal),
    contentState('main.ts'), 'content', 'Contents.', contentOptions(registry));
  assert.equal(actual, 'const value = 1;\n');
  assert.equal(calls, 2, 'exactly one retry');
  assert.deepEqual(states[1]?.generation?.syntax, [{ message: "',' expected.", offset: 4 }]);
  assert.equal(states[1]?.generation?.reason, "',' expected.");
  assert.equal(states[0]?.generation, undefined, 'the first attempt carries no syntax hint');
});

test('a JS/TS retry that fails again surfaces the second diagnostic without looping', async () => {
  let calls = 0;
  const adapter = adapterFor('javascript', '.js', () => (++calls === 1 ? 'f(1 2);\n' : 'const x = (1;\n'),
    source => { throw new Error(source.startsWith('f(') ? "',' expected." : "')' expected."); });
  const registry = new AstRegistry([adapter], false);
  await assert.rejects(generateText(new Decisions(new ScriptedProvider([{ action: 'write_file', args: { path: 'main.js', content: 'x' } }]), 100, new AbortController().signal),
    contentState('main.js'), 'content', 'Contents.', contentOptions(registry)), /failed validation after one narrowed retry.*\)' expected/);
  assert.equal(calls, 2, 'no loop after the second failure');
});

test('validation failures on other dialects do not retry', async () => {
  let calls = 0;
  const adapter = adapterFor('rust', '.rs', () => { calls++; return 'fn main() {}\n'; }, () => { throw new Error('rustc rejected the source'); });
  const registry = new AstRegistry([adapter], false);
  await assert.rejects(generateText(new Decisions(new ScriptedProvider([{ action: 'write_file', args: { path: 'main.rs', content: 'x' } }]), 100, new AbortController().signal),
    contentState('main.rs'), 'content', 'Contents.', contentOptions(registry)), /rustc rejected the source/);
  assert.equal(calls, 1, 'only JS/TS gets the narrowed retry');
});

test('a JS/TS syntax hint drops productions matching the diagnostic in the retry', async () => {
  const run = async (syntax: Array<{ message: string; offset: number }>): Promise<Record<string, string[]>> => {
    const seen: Record<string, string[]> = {};
    const states: Array<{ generation?: { syntax?: unknown } }> = [];
    const counts = new Map<string, number>();
    const provider: DecisionProvider = { decide: async (input, questions) => {
      const q = questions.selection;
      if (!q || q.type !== 'choice') throw new Error('Expected a choice question.');
      states.push(structuredClone(input) as never);
      const slot = (input as { generation: { slot: string } }).generation.slot;
      const n = counts.get(slot) ?? 0;
      counts.set(slot, n + 1);
      const keys = Object.keys(q.criteria);
      seen[slot] = keys;
      const pick = (label: string): string => keys.includes(label) ? label : keys[0]!;
      const choice = slot === 'module_body' ? pick(n === 0 ? 'print' : 'finish') : slot === 'printed' ? pick('string') : keys[0]!;
      return { model: 't', usage: { input_tokens: 0, output_tokens: 0 }, answers: { selection: { type: 'choice', choice, confidence: 1,
        probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) } } } as never;
    } };
    await generateProgram(typescriptDialect, new Decisions(provider, 100, new AbortController().signal),
      { task: { prompt: 'print hello' }, generation: { syntax } }, 'content', { fragments: [], maxSteps: 32, maxBytes: 1000, allowEmpty: false });
    assert.deepEqual(states[0]?.generation?.syntax, syntax, 'the diagnostic stays visible in the decision state');
    return seen;
  };

  const comma = await run([{ message: "',' expected.", offset: 4 }]);
  assert.ok(comma['printed']!.includes('string'));
  assert.ok(!comma['printed']!.includes('call') && !comma['printed']!.includes('list'), `comma diagnostic drops call/list: ${comma['printed']}`);
  assert.ok(comma['module_body']!.includes('if'), 'the comma diagnostic does not drop block productions');

  const brace = await run([{ message: "'}' expected.", offset: 4 }]);
  for (const dropped of ['if', 'while', 'range', 'foreach', 'function']) assert.ok(!brace['module_body']!.includes(dropped), `brace diagnostic drops ${dropped}`);
  assert.ok(brace['module_body']!.includes('print') && brace['module_body']!.includes('finish'));

  const unmatched = await run([{ message: 'Expression expected.', offset: 4 }]);
  assert.ok(unmatched['printed']!.includes('call'), 'unmatched diagnostics stay message-only');
});
