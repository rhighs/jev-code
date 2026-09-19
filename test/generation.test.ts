import assert from 'node:assert/strict';
import test from 'node:test';
import { AstRegistry } from '../src/ast-adapters.js';
import { Decisions } from '../src/decisions.js';
import { generateArguments, generateText, syntaxFeedback } from '../src/generation.js';
import { characterAlphabet } from '../src/grid.js';
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
