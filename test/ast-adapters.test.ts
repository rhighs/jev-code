import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AstRegistry, installAstModule, loadInstalledAsts, removeAstAdapter } from '../src/ast-adapters.js';
import { Decisions } from '../src/decisions.js';
import { generateText } from '../src/generation.js';
import type { DecisionProvider } from '../src/types.js';

const noModel: DecisionProvider = { decide: async () => { throw new Error('Unexpected model call'); } };
const adapter = { id: 'test-json', extensions: ['.json'], languages: ['json'], async generate() { return '{"ok":true}\n'; }, async validate(source: string) { JSON.parse(source); } };

test('installed AST adapters persist, reload, route by extension and language, then remove', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'json.mjs');
  await writeFile(file, 'export const astAdapters = [{ id: "test-json", extensions: [".json"], languages: ["json"], async generate() { return "{}\\n"; }, async validate(source) { JSON.parse(source); } }];');
  await installAstModule(root, './json.mjs');
  const registry = new AstRegistry(await loadInstalledAsts(root));
  assert.equal(registry.resolve({ argumentsSoFar: { path: 'settings.json' } })?.id, 'test-json');
  assert.equal(registry.resolve({ task: { prompt: 'Create json configuration.' } })?.id, 'test-json');
  assert.equal(registry.resolve({ task: { prompt: 'Use Python.' } })?.id, 'python');
  await assert.rejects(installAstModule(root, './json.mjs'), /Duplicate/);
  assert.equal((JSON.parse(await readFile(join(root, '.jev/asts.json'), 'utf8'))).adapters.length, 1);
  await removeAstAdapter(root, 'test-json');
  assert.equal((await loadInstalledAsts(root)).length, 0);
});

test('registration rejects conflicting extensions and adapters without validators', () => {
  const registry = new AstRegistry([adapter]);
  assert.throws(() => registry.register({ ...adapter, id: 'collision' }), /extension/);
  assert.throws(() => registry.register({ ...adapter, id: 'python' }), /Duplicate/);
  assert.throws(() => registry.register({ ...adapter, id: 'invalid', validate: undefined } as never), /validate/);
});

test('registry snapshots cannot mutate registered ids, extensions or languages', () => {
  const registry = new AstRegistry([adapter]);
  const listed = registry.list().find(item => item.id === adapter.id)!;
  listed.extensions[0] = '.oops'; listed.languages[0] = 'oops'; listed.id = 'oops';
  const resolved = registry.resolve({ task: { prompt: 'Create json.' } })!;
  resolved.extensions[0] = '.oops';
  assert.equal(registry.resolve({ argumentsSoFar: { path: 'settings.json' } })?.id, adapter.id);
  assert.equal(registry.resolve({ argumentsSoFar: { path: 'settings.oops' } }), undefined);
  assert.equal(registry.resolve({ argumentsSoFar: { path: 'README.md' }, task: { prompt: 'Explain Python in README.md.' } }), undefined);
});

test('bundled TypeScript adapter installs by stable name in any workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-bundled-ast-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await installAstModule(root, 'builtin:typescript'), ['typescript']);
  const adapters = await loadInstalledAsts(root);
  assert.equal(adapters[0]?.id, 'typescript');
  assert.equal(new AstRegistry(adapters).resolve({ argumentsSoFar: { path: 'main.ts' } })?.id, 'typescript');
});

test('adapter source is validated and bounded before generation completes', async () => {
  const registry = new AstRegistry([adapter]);
  const events: boolean[] = [];
  const options = { maxSteps: 20, maxBytes: 100, allowEmpty: false, fragments: [], astRegistry: registry, onText: async (_field: string, _text: string, done: boolean) => { events.push(done); } };
  const source = await generateText(new Decisions(noModel, 10, new AbortController().signal), { argumentsSoFar: { path: 'settings.json' } }, 'content', 'Contents', options);
  assert.equal(source, '{"ok":true}\n');
  assert.equal(events.at(-1), true);
  await assert.rejects(generateText(new Decisions(noModel, 10, new AbortController().signal), { argumentsSoFar: { path: 'settings.json' } }, 'content', 'Contents', { ...options, maxBytes: 1 }), /byte|size/);
  const invalid = new AstRegistry([{ ...adapter, async generate() { return '{'; } }]);
  await assert.rejects(generateText(new Decisions(noModel, 10, new AbortController().signal), { argumentsSoFar: { path: 'settings.json' } }, 'content', 'Contents', { ...options, astRegistry: invalid }), /JSON/);
});

test('optional TypeScript adapter builds real compiler AST nodes and validates source', async () => {
  const { typescriptAstAdapter } = await import('../src/typescript-ast.js');
  const provider: DecisionProvider = { decide: async (_state, questions) => {
    const question = questions.selection!;
    assert.equal(question.type, 'choice');
    if (question.type !== 'choice') throw new Error('Expected Choice');
    const input = _state as unknown as { generation: { slot: string; partialSource: string } };
    let selected = input.generation.slot === 'module_body' ? (input.generation.partialSource ? 'finish' : 'print') : 'number';
    if (input.generation.slot === 'number') selected = Object.entries(question.criteria).find(([, value]) => value === '42')![0];
    return { model: 'ts-fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: { selection: { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selected)])) } } } as never;
  } };
  const registry = new AstRegistry([typescriptAstAdapter]);
  const source = await generateText(new Decisions(provider, 20, new AbortController().signal), { task: { prompt: 'TypeScript print 42.' }, argumentsSoFar: { path: 'main.ts' } }, 'content', 'Source', { maxSteps: 20, maxBytes: 8000, allowEmpty: false, fragments: [], astRegistry: registry });
  assert.equal(source, 'console.log(42);\n');
  await assert.rejects(typescriptAstAdapter.validate('const = ;', new AbortController().signal));
});
