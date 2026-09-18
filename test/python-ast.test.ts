import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Decisions } from '../src/decisions.js';
import { generatePythonAst, unparsePython } from '../src/python-ast.js';
import { Harness } from '../src/harness.js';
import type { DecisionProvider, HarnessEvent } from '../src/types.js';
import { ScriptedProvider } from './helpers.js';

interface AstState { generation: { phase: string; slot: string; partialSource: string; partialAst?: unknown; symbols: string[]; constraints: { inFunction: boolean; inLoop: boolean } } }
class AstProvider implements DecisionProvider {
  states: AstState[] = [];
  criteria: Array<Record<string, EntryType>> = [];
  constructor(private script: Array<string | { value: string }>, private fallback?: DecisionProvider) {}
  async decide<Q extends Questions>(input: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    const state = input as unknown as AstState;
    if (state.generation?.phase !== 'ast') {
      assert.ok(this.fallback, 'Unexpected non-AST decision');
      return this.fallback.decide(input, questions, signal);
    }
    this.states.push(structuredClone(state));
    const desired = this.script.shift();
    assert.notEqual(desired, undefined, `Missing AST decision for ${state.generation.slot}`);
    const question = questions.selection!;
    assert.equal(question.type, 'choice');
    if (question.type !== 'choice') throw new Error('Expected Choice');
    this.criteria.push({ ...question.criteria });
    const selection = typeof desired === 'string' ? desired : Object.entries(question.criteria).find(([, label]) => label === desired!.value)?.[0];
    assert.ok(selection && Object.hasOwn(question.criteria, selection), `Unavailable production ${JSON.stringify(desired)} in ${state.generation.slot}`);
    return { model: 'ast-fixture', usage: { input_tokens: 10, output_tokens: 2 }, answers: {
      selection: { type: 'choice', choice: selection, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selection)])) },
    } } as unknown as SystemOneResult<Q>;
  }
}
const hello = () => ['expr', 'call', { value: 'print' }, '1', 'string', { value: JSON.stringify('Hello, world!') }, 'finish'];
const state = { task: { prompt: 'Create a simple Python hello world.', turn: 1, updates: [] } };
const options = { maxSteps: 100, maxBytes: 8000, allowEmpty: false, fragments: [] };
const decisions = (provider: DecisionProvider) => new Decisions(provider, 100, new AbortController().signal);

test('Python AST builds a complete tree, streams productions and unparses executable source', async () => {
  const provider = new AstProvider(['0', ...hello()]);
  const progress: string[] = [];
  const source = await generatePythonAst(decisions(provider), state, 'content', { ...options,
    onText: async (_field, _text, _done, _change, event) => { if (event?.ast) progress.push(event.ast.production); },
  });
  assert.equal(source, "print('Hello, world!')\n");
  assert.equal(progress.length, 8);
  assert.deepEqual(progress.slice(0, 6), ['0', 'expr', 'call', 'name_0', '1', 'string']);
  assert.equal(progress.at(-1), 'finish');
  assert.ok(provider.states.every(state => !Object.hasOwn(state.generation, 'partialAst')));
  const argument = provider.states.find(state => state.generation.slot === 'argument_0')!;
  assert.match(argument.generation.partialSource, /print\(__jev_pending__\)/);
  const statement = provider.states.find(state => state.generation.slot === 'module_body')!;
  assert.equal(statement.generation.partialSource, '__jev_pending__\n');
  assert.equal(provider.states.at(-1)!.generation.partialSource, "print('Hello, world!')\n__jev_pending__\n");
});

test('function parameters enter the symbol table and return is allowed only in function scope', async () => {
  const provider = new AstProvider(['0', 'function', { value: JSON.stringify('add') }, '2', { value: JSON.stringify('a') }, { value: JSON.stringify('b') },
    'return', 'binary', 'Add', 'name', { value: 'a' }, 'name', { value: 'b' }, 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Write Python add(a, b), return a plus b.' } }, 'content', options);
  assert.equal(source, 'def add(a, b):\n    return a + b\n');
  const body = provider.states.find(state => state.generation.slot === 'function_body')!;
  assert.equal(body.generation.constraints.inFunction, true);
  assert.ok(body.generation.symbols.includes('a') && body.generation.symbols.includes('b'));
  const root = provider.states.at(-1)!;
  assert.equal(root.generation.constraints.inFunction, false);
  assert.ok(!root.generation.symbols.includes('a'));
  assert.ok(!Object.hasOwn(provider.criteria[1]!, 'return'));
  assert.ok(!Object.hasOwn(provider.criteria[1]!, 'break'));
  assert.ok(Object.hasOwn(provider.criteria[6]!, 'return'));
});

test('nested functions reset loop scope and cannot break an enclosing function’s loop', async () => {
  const provider = new AstProvider(['0', 'for', { value: JSON.stringify('i') }, 'call', { value: 'range' }, '1', 'number', { value: '2' },
    'function', { value: JSON.stringify('main') }, '0', 'pass', 'finish', 'break', 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Python loop with i in range(2), define main with an empty body, then break.' } }, 'content', options);
  assert.match(source, /for i in range\(2\):\n+    def main\(\):\n        pass\n    break/);
  const functionBody = provider.states.findIndex(state => state.generation.slot === 'function_body');
  assert.ok(functionBody >= 0);
  assert.equal(provider.states[functionBody]!.generation.constraints.inLoop, false);
  assert.ok(!Object.hasOwn(provider.criteria[functionBody]!, 'break'));
  const loopBody = provider.states.findIndex(state => state.generation.slot === 'loop_body');
  assert.ok(Object.hasOwn(provider.criteria[loopBody]!, 'break'));
});

test('AST terminal strings preserve Unicode and escapes through Python unparse', async () => {
  const message = 'héllo 🌍 \\ end';
  const provider = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'string', { value: JSON.stringify(message) }, 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: `Python print "${message}".` } }, 'content', options);
  assert.equal(source, "print('héllo 🌍 \\\\ end')\n");
});

test('completed empty modules and byte limits are validated without executing source', async () => {
  const tree = { _type: 'Module', body: [], type_ignores: [] };
  assert.equal(await unparsePython(tree, new AbortController().signal), '');
  await assert.rejects(unparsePython({ _type: 'Module', body: [{ _type: 'Expr', value: { _type: 'Constant', value: 'long text', kind: null } }], type_ignores: [] }, new AbortController().signal, 1), /byte budget|byte limit/);
  await assert.rejects(unparsePython(tree, AbortSignal.abort(new Error('Cancelled'))), /Cancelled/);
});

test('assignment RHS cannot reference a name before it is defined', async () => {
  const provider = new AstProvider(['0', 'assign', { value: JSON.stringify('message') }, 'string', { value: JSON.stringify('hello') },
    'expr', 'call', { value: 'print' }, '1', 'name', 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'In Python assign hello to message and print message.' } }, 'content', options);
  assert.equal(source, "message = 'hello'\nprint(message)\n");
  assert.ok(!provider.states.find(state => state.generation.slot === 'string')!.generation.symbols.includes('message'));
  assert.ok(provider.states.find(state => state.generation.slot === 'argument_0')!.generation.symbols.includes('message'));
});

test('defined functions constrain call arity from the symbol table', async () => {
  const provider = new AstProvider(['0', 'function', { value: JSON.stringify('add') }, '2', { value: JSON.stringify('a') }, { value: JSON.stringify('b') },
    'return', 'binary', 'Add', 'name', { value: 'a' }, 'name', { value: 'b' },
    'expr', 'call', { value: 'print' }, '1', 'call', { value: 'add' }, 'number', { value: '1' }, 'number', { value: '2' }, 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Python define add(a, b) returning a + b, then print add(1, 2).' } }, 'content', options);
  assert.match(source, /def add\(a, b\):\n    return a \+ b/);
  assert.match(source, /print\(add\(1, 2\)\)/);
  assert.equal(provider.states.filter(state => state.generation.slot === 'argument_count').length, 1, 'Known function arity is enforced without asking for another count');
});

test('calls to imported module members use a defined receiver', async () => {
  const provider = new AstProvider(['0', 'import', 'math', 'expr', 'call', { value: 'print' }, '1', 'call', 'member', { value: 'math' },
    { value: JSON.stringify('sqrt') }, '1', 'number', { value: '16' }, 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Python import math and print math.sqrt(16).' } }, 'content', options);
  assert.equal(source, 'import math\nprint(math.sqrt(16))\n');
});

test('unavailable productions and invalid completed ASTs fail validation', async () => {
  const bad: DecisionProvider = { decide: async () => ({ model: 'bad', usage: { input_tokens: 0, output_tokens: 0 },
    answers: { selection: { type: 'choice', choice: 'return', confidence: 1, probabilities: { return: 1 } } } } as never) };
  await assert.rejects(generatePythonAst(decisions(bad), state, 'content', options), /unavailable choice/);
  await assert.rejects(unparsePython({ _type: 'Module', body: [{ _type: 'Return', value: { _type: 'Constant', value: 1, kind: null } }], type_ignores: [] }, new AbortController().signal), /outside function/);
  await assert.rejects(unparsePython({ _type: 'Module', body: [{ _type: 'Hole' }], type_ignores: [] }, new AbortController().signal), /Invalid AST node/);
});

test('harness writes Python only after AST completion and verifies it with a real command', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-ast-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fallback = new ScriptedProvider([
    { action: 'write_file', args: { path: 'main.py' } },
    { action: 'bash', args: { command: 'python3 main.py', cwd: '.', timeout_ms: '' } },
    { action: 'finish', args: { summary: 'Created and verified hello world.' } },
  ]);
  const events: HarnessEvent[] = [];
  const result = await new Harness({ workspace: root, provider: new AstProvider(['0', ...hello()], fallback), journalDirectory: false,
    onEvent: async event => {
      events.push(event);
      if (event.type === 'text' && event.data.decoder === 'ast' && event.data.field === 'content') assert.deepEqual(await readdir(root), []);
    },
  }).run('Create a simple Python hello world and run it.');
  assert.equal(result.status, 'completed', result.summary);
  assert.ok(events.some(event => event.type === 'start' && event.data.decoder === 'dynamic'));
  assert.equal(await readFile(join(root, 'main.py'), 'utf8'), "print('Hello, world!')\n");
  assert.equal(result.records[1]!.result.ok, true);
  assert.match(result.records[1]!.result.output, /Hello, world!/);
  assert.ok(events.some(event => event.type === 'text' && event.data.decoder === 'ast' && event.data.done));
});

test('incomplete AST budget exhaustion never writes a partial file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-ast-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fallback = new ScriptedProvider([{ action: 'write_file', args: { path: 'main.py' } }, { action: 'finish', verdict: 1 }]);
  const result = await new Harness({ workspace: root, provider: new AstProvider(['0', ...hello()], fallback), maxGenerationSteps: 3, journalDirectory: false }).run('Create Python hello world.');
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(result.records[0]?.tool, 'write_file');
  assert.equal(result.records[0]?.result.ok, false);
  assert.match(result.records[0]?.result.output ?? '', /production budget/);
  assert.deepEqual(await readdir(root), []);
});

test('custom AST terminals stay in AST choices and never enter grid decoding', async () => {
  const provider = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'string', 'custom',
    { value: JSON.stringify('a') }, { value: JSON.stringify('b') }, 'end', 'finish']);
  const source = await generatePythonAst(decisions(provider), state, 'content', options);
  assert.equal(source, "print('ab')\n");
  assert.ok(provider.states.every(state => state.generation.phase === 'ast'));
});

test('numeric terminals offer constants only and string spelling stops after three identical pieces', async () => {
  const provider = new AstProvider(['0', 'for', { value: JSON.stringify('i') }, 'call', { value: 'range' }, '1', 'number', { value: '50' }, 'pass', 'finish', 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Write a for loop in Python.' } }, 'content', options);
  assert.equal(source, 'for i in range(50):\n    pass\n');
  const number = provider.states.findIndex(state => state.generation.slot === 'number');
  assert.ok(!Object.keys(provider.criteria[number]!).includes('custom'));
  const spelled = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'string', 'custom',
    { value: JSON.stringify('a') }, { value: JSON.stringify('a') }, { value: JSON.stringify('a') }, 'finish']);
  assert.equal(await generatePythonAst(decisions(spelled), state, 'content', options), "print('aaa')\n");
  assert.ok(!spelled.states.some(state => String(state.generation.slot).startsWith('string_token:"aaa"')));
});

test('blocks cannot repeat pass, are capped in length, identifiers never spell, and range needs an argument', async () => {
  const loop = new AstProvider(['0', 'while', 'boolean', 'true', 'pass', 'finish', 'finish']);
  assert.equal(await generatePythonAst(decisions(loop), state, 'content', options), 'while True:\n    pass\n');
  const after = loop.states.findIndex((s, i) => s.generation.slot === 'loop_body' && i > loop.states.findIndex(x => x.generation.slot === 'loop_body'));
  assert.ok(after > 0);
  assert.ok(!Object.keys(loop.criteria[after]!).includes('pass'));
  const script: Array<string | { value: string }> = ['0'];
  for (let i = 0; i < 16; i++) script.push('expr', 'call', { value: 'print' }, '0');
  const capped = new AstProvider(script);
  const source = await generatePythonAst(decisions(capped), state, 'content', options);
  assert.equal(source.split('\n').filter(Boolean).length, 16);
  assert.ok(!capped.states.some(s => s.generation.slot === 'module_body' && Object.keys(capped.criteria[capped.states.indexOf(s)]!).includes('finish') && capped.states.indexOf(s) === capped.states.length - 1));
  const named = new AstProvider(['0', 'assign', { value: JSON.stringify('result') }, 'number', { value: '1' }, 'finish']);
  await generatePythonAst(decisions(named), state, 'content', options);
  const nameSlot = named.states.findIndex(s => s.generation.slot === 'assignment_name');
  assert.ok(!Object.keys(named.criteria[nameSlot]!).includes('custom'));
  const ranged = new AstProvider(['0', 'for', { value: JSON.stringify('i') }, 'call', { value: 'range' }, '1', 'number', { value: '5' }, 'pass', 'finish', 'finish']);
  await generatePythonAst(decisions(ranged), { task: { prompt: 'Write a for loop in Python.' } }, 'content', options);
  const count = ranged.states.findIndex(s => s.generation.slot === 'argument_count');
  assert.deepEqual(Object.keys(ranged.criteria[count]!), ['1', '2', '3']);
});

test('ordinary for-loop range bounds exclude zero and builtins are not variable references', async () => {
  const provider = new AstProvider(['0', 'for', { value: JSON.stringify('i') }, 'call', { value: 'range' }, '1', 'number', { value: '5' },
    'expr', 'call', { value: 'print' }, '1', 'name', 'finish', 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Write a for loop in Python.' } }, 'content', options);
  assert.equal(source, 'for i in range(5):\n    print(i)\n');
  const number = provider.states.findIndex(state => state.generation.slot === 'number');
  assert.ok(!Object.values(provider.criteria[number]!).includes('0'));
  assert.ok(Object.values(provider.criteria[number]!).includes('5'));
});

test('explicitly requested empty and negative ranges retain their literal bounds', async () => {
  for (const bound of [0, -2]) {
    const provider = new AstProvider(['0', 'for', { value: JSON.stringify('i') }, 'call', { value: 'range' }, '1', 'number', { value: String(bound) }, 'pass', 'finish', 'finish']);
    const source = await generatePythonAst(decisions(provider), { task: { prompt: `Python for i in range(${bound}), empty body.` } }, 'content', options);
    assert.equal(source, `for i in range(${bound}):\n    pass\n`);
  }
});

test('an else branch renders its pending slot as a statement so the preview never rejects the tree', async () => {
  const provider = new AstProvider(['0', 'if', 'boolean', 'true', 'pass', 'finish', 'yes', 'pass', 'finish', 'finish']);
  assert.equal(await generatePythonAst(decisions(provider), state, 'content', options), 'if True:\n    pass\nelse:\n    pass\n');
  const elseBody = provider.states.find(s => s.generation.slot === 'else_body');
  assert.match(elseBody?.generation.partialSource ?? '', /else:\n\s+__jev_pending__/);
});
