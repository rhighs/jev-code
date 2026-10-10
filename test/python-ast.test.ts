import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Decisions } from '../src/decisions.js';
import { generatePythonAst, unparsePython } from '../src/python-ast.js';
import { attemptScope, closeDefaultRunContext, createRunContext, defaultRunContext } from '../src/run-context.js';
import { Harness } from '../src/harness.js';
import type { DecisionEventData, DecisionProvider, HarnessEvent } from '../src/types.js';
import { ScriptedProvider } from './helpers.js';

interface AstState { generation: { phase: string; slot?: string; partialSource: string; partialAst?: unknown; symbols: string[]; symbolTable?: Record<string, { kind: string; arity?: number; params?: string[] }>; constraints: { inFunction: boolean; inLoop: boolean } } }
class AstProvider implements DecisionProvider {
  states: AstState[] = [];
  criteria: Array<Record<string, EntryType>> = [];
  /** Slot of every asked question, in request order (wave questions use their key). */
  slots: string[] = [];
  /** Question keys per request, so wave batching is observable. */
  asked: string[][] = [];
  constructor(private script: Array<string | { value: string }>, private fallback?: DecisionProvider) {}
  async decide<Q extends Questions>(input: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    const state = input as unknown as AstState;
    if (state.generation?.phase !== 'ast') {
      assert.ok(this.fallback, 'Unexpected non-AST decision');
      return this.fallback.decide(input, questions, signal);
    }
    this.states.push(structuredClone(state));
    this.asked.push(Object.keys(questions).map(key => key === 'selection' && state.generation.slot !== undefined ? state.generation.slot : key));
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(questions)) {
      const desired = this.script.shift();
      assert.notEqual(desired, undefined, `Missing AST decision for ${state.generation.slot ?? key}`);
      assert.equal(question.type, 'choice');
      if (question.type !== 'choice') throw new Error('Expected Choice');
      this.criteria.push({ ...question.criteria });
      this.slots.push(state.generation.slot ?? key);
      const selection = typeof desired === 'string' ? desired : Object.entries(question.criteria).find(([, label]) => label === desired!.value)?.[0];
      assert.ok(selection && Object.hasOwn(question.criteria, selection), `Unavailable production ${JSON.stringify(desired)} in ${state.generation.slot ?? key}`);
      answers[key] = { type: 'choice', choice: selection, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, Number(label === selection)])) };
    }
    return { model: 'ast-fixture', usage: { input_tokens: 10, output_tokens: 2 }, answers } as unknown as SystemOneResult<Q>;
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
    'return', 'binary', 'Add', 'name', 'name', { value: 'a' }, { value: 'b' }, 'finish']);
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
    'return', 'binary', 'Add', 'name', 'name', { value: 'a' }, { value: 'b' },
    'expr', 'call', { value: 'print' }, '1', 'call', { value: 'add' }, 'number', 'number', { value: '1' }, { value: '2' }, 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Python define add(a, b) returning a + b, then print add(1, 2).' } }, 'content', options);
  assert.match(source, /def add\(a, b\):\n    return a \+ b/);
  assert.match(source, /print\(add\(1, 2\)\)/);
  assert.equal(provider.states.filter(state => state.generation.slot === 'argument_count').length, 1, 'Known function arity is enforced without asking for another count');
});

test('calls to imported module members fill the callee from the curated table and derive the count host-side', async () => {
  const provider = new AstProvider(['0', 'import', 'math', 'expr', 'call', { value: 'print' }, '1', 'call', 'member', { value: 'math' },
    'sqrt', 'number', { value: '16' }, 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Python import math and print math.sqrt(16).' } }, 'content', options);
  assert.equal(source, 'import math\nprint(math.sqrt(16))\n');
  const member = provider.states.findIndex(state => state.generation.slot === 'member');
  assert.ok(member >= 0, 'the member pick replaces the spelled method name');
  assert.match(String(provider.criteria[member]!.sqrt), /math\.sqrt\(x: number\) -> number/, 'the member criteria carry the curated signature');
  assert.ok(!provider.states.some(state => state.generation.slot === 'method_name'), 'a curated module never spells its member');
  assert.equal(provider.states.filter(state => state.generation.slot === 'argument_count').length, 1, 'sqrt arity 1 is host-derived; only print asks');
  const table = provider.states.at(-1)!.generation.symbolTable!;
  assert.deepEqual(table.input!.params, ['string'], 'builtin symbols carry curated parameter types');
  assert.deepEqual(table.range!.params, ['number', 'number', 'number']);
});

test('member arguments narrow by parameter type: randint offers numbers with no range or None', async () => {
  const provider = new AstProvider(['0', 'import', 'random', 'expr', 'call', { value: 'print' }, '1', 'call', 'member', { value: 'random' },
    'randint', 'number', 'number', { value: '1' }, { value: '100' }, 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Python import random and print random.randint(1, 100).' } }, 'content', options);
  assert.equal(source, 'import random\nprint(random.randint(1, 100))\n');
  const memberAt = provider.slots.findIndex(slot => slot === 'member');
  assert.ok(memberAt >= 0);
  assert.match(String(provider.criteria[memberAt]!.randint), /random\.randint\(a: number, b: number\) -> number/);
  const args = provider.criteria.filter((_, index) => index > memberAt && /^argument_[01]$/.test(provider.slots[index]!));
  assert.equal(args.length, 2, 'both randint number arguments are asked');
  for (const criteria of args) {
    assert.ok(Object.hasOwn(criteria, 'number'));
    assert.ok(!Object.hasOwn(criteria, 'boolean'), 'None is not offered for a number parameter');
    assert.ok(!Object.hasOwn(criteria, 'string'));
    assert.ok(!Object.hasOwn(criteria, 'list'));
  }
  assert.equal(provider.states.filter(state => state.generation.slot === 'argument_count').length, 1, 'randint arity 2 is host-derived; only print asks');
});

test('a typed argument narrows its callee candidates and the member list by result type', async () => {
  const provider = new AstProvider(['0', 'import', 'random', 'import', 'math', 'assign', { value: JSON.stringify('target') },
    'call', 'member', { value: 'math' }, 'sqrt', 'call', 'member', { value: 'random' }, 'randint', 'number', 'number', { value: '1' }, { value: '100' }, 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Python import random and math, then target = math.sqrt(random.randint(1, 100)).' } }, 'content', options);
  assert.equal(source, 'import random\nimport math\ntarget = math.sqrt(random.randint(1, 100))\n');

  const sqrtMember = provider.states.findIndex(state => state.generation.slot === 'member');
  const innerCallee = provider.states.findIndex((state, index) => index > sqrtMember && state.generation.slot === 'callee');
  const randintMember = provider.states.findIndex((state, index) => index > innerCallee && state.generation.slot === 'member');
  assert.ok(sqrtMember >= 0 && innerCallee > sqrtMember && randintMember > innerCallee);

  const calleeCriteria = provider.criteria[innerCallee]!;
  const calleeValues = Object.values(calleeCriteria);
  assert.ok(Object.hasOwn(calleeCriteria, 'member'), 'a member call can still produce a number');
  assert.ok(calleeValues.includes('len'), 'number-returning builtins stay');
  assert.ok(!calleeValues.includes('range'), 'range returns a list, not a number');
  assert.ok(!calleeValues.includes('print'), 'print returns None, not a number');
  assert.ok(!calleeValues.includes('str') && !calleeValues.includes('input'), 'string-returning calls are not numbers');

  const members = provider.criteria[randintMember]!;
  assert.ok(Object.hasOwn(members, 'randint'));
  assert.ok(Object.hasOwn(members, 'choice'), 'unknown-result members still fit');
  assert.ok(!Object.hasOwn(members, 'sample'), 'list-returning members are not numbers');
  assert.ok(!Object.hasOwn(members, 'shuffle') && !Object.hasOwn(members, 'seed'), 'None-returning members are not numbers');
  assert.equal(provider.states.filter(state => state.generation.slot === 'argument_count').length, 0, 'sqrt and randint arities are host-derived');
});

test('a multi-arity member offers exactly its accepted counts and narrows its arguments', async () => {
  const provider = new AstProvider(['0', 'import', 'random', 'expr', 'call', { value: 'print' }, '1', 'call', 'member', { value: 'random' },
    'randrange', '1', 'number', { value: '10' }, 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Python import random and print random.randrange(10).' } }, 'content', options);
  assert.equal(source, 'import random\nprint(random.randrange(10))\n');
  const member = provider.states.findIndex(state => state.generation.slot === 'member');
  const countAt = provider.states.findIndex((state, index) => index > member && state.generation.slot === 'argument_count');
  assert.ok(countAt >= 0, 'a multi-arity member asks for a count');
  assert.deepEqual(Object.keys(provider.criteria[countAt]!), ['1', '2', '3'], 'wrong arities (0 and 4) are not offered');
  const arg = provider.states.findIndex((state, index) => index > countAt && state.generation.slot === 'argument_0');
  assert.ok(Object.hasOwn(provider.criteria[arg]!, 'number') && !Object.hasOwn(provider.criteria[arg]!, 'boolean'));
  assert.equal(provider.states.filter(state => state.generation.slot === 'argument_count').length, 2, 'print and randrange ask; no other count');
});

test('a call on an unknown receiver keeps the spelling path', async () => {
  const provider = new AstProvider(['0', 'assign', { value: JSON.stringify('message') }, 'string', { value: JSON.stringify('hello') },
    'expr', 'call', { value: 'print' }, '1', 'call', 'member', { value: 'message' }, { value: JSON.stringify('lower') }, '0', 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'In Python assign hello to message and print message.lower().' } }, 'content', options);
  assert.equal(source, "message = 'hello'\nprint(message.lower())\n");
  assert.ok(provider.states.some(state => state.generation.slot === 'method_name'), 'the method name is spelled for an unknown receiver');
  assert.ok(!provider.states.some(state => state.generation.slot === 'member'), 'no curated member pick without a module receiver');
});

test('builtin parameters narrow their arguments: an input prompt accepts only a string', async () => {
  const provider = new AstProvider(['0', 'import', 'random',
    'assign', { value: JSON.stringify('target') }, 'call', 'member', { value: 'random' }, 'randint', 'number', 'number', { value: '1' }, { value: '100' },
    'assign', { value: JSON.stringify('guess') }, 'call', { value: 'int' }, '1', 'call', { value: 'input' }, '1', 'string', { value: JSON.stringify('Guess: ') },
    'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Write a Python guessing game: import random, set target = random.randint(1, 100), then guess = int(input("Guess: ")).' } }, 'content', options);
  assert.equal(source, "import random\ntarget = random.randint(1, 100)\nguess = int(input('Guess: '))\n");
  const inputAt = provider.slots.findLastIndex((slot, index) => slot === 'callee' && Object.values(provider.criteria[index]!).includes('input'));
  assert.ok(inputAt >= 0);
  const promptAt = provider.slots.findIndex((slot, index) => index > inputAt && slot === 'argument_0');
  const prompt = provider.criteria[promptAt]!;
  assert.ok(Object.hasOwn(prompt, 'string'));
  assert.ok(!Object.hasOwn(prompt, 'number') && !Object.hasOwn(prompt, 'boolean') && !Object.hasOwn(prompt, 'list'), 'only string candidates fit an input prompt');
  assert.equal(provider.states.filter(state => state.generation.slot === 'argument_count').length, 2, 'int and input keep their count questions; randint is host-derived');
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

test('a task-derived literal resolves from the enriched custom pieces in one pick', async () => {
  const provider = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'string', 'custom', { value: JSON.stringify('Hello, world!') }, 'end', 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Print "Hello, world!".' } }, 'content', options);
  assert.equal(source, "print('Hello, world!')\n");
  const tokenAt = provider.states.findIndex(state => state.generation.slot === 'string_token:""');
  assert.ok(tokenAt >= 0);
  assert.ok(Object.values(provider.criteria[tokenAt]!).includes(JSON.stringify('Hello, world!')), 'the quoted task literal is offered as one piece');
  assert.deepEqual(provider.states.filter(state => String(state.generation.slot).startsWith('string_token:')).map(state => state.generation.slot),
    ['string_token:""', 'string_token:"Hello, world!"'], 'one piece pick composes the literal, then end');
});

test('custom spelling prefers the longest continuation of a known literal', async () => {
  const provider = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'string', 'custom',
    { value: JSON.stringify('Hello') }, { value: JSON.stringify(', world!') }, 'end', 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Print "Hello, world!".' } }, 'content', options);
  assert.equal(source, "print('Hello, world!')\n");
  assert.deepEqual(provider.states.filter(state => String(state.generation.slot).startsWith('string_token:')).map(state => state.generation.slot),
    ['string_token:""', 'string_token:"Hello"', 'string_token:"Hello, world!"'], 'two multi-character piece picks complete the literal');
  const secondAt = provider.states.findIndex(state => state.generation.slot === 'string_token:"Hello"');
  assert.ok(secondAt >= 0);
  assert.equal(provider.criteria[secondAt]!.piece_0, JSON.stringify(', world!'), 'the longest matching continuation is offered first');
  assert.ok(!Object.values(provider.criteria[secondAt]!).includes(JSON.stringify('Hello, world!')), 'a piece that would duplicate the prefix is not offered');
});

test('a novel literal spells from the longest task pieces within a handful of requests', async () => {
  const provider = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'string', 'custom',
    { value: JSON.stringify('split') }, { value: JSON.stringify(' ') }, { value: JSON.stringify('banana') }, 'end', 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Print the words banana split.' } }, 'content', options);
  assert.equal(source, "print('split banana')\n");
  const tokenAt = provider.states.findIndex(state => state.generation.slot === 'string_token:""');
  const first = provider.criteria[tokenAt]!;
  assert.ok(Object.values(first).includes(JSON.stringify('banana')) && Object.values(first).includes(JSON.stringify('split')), 'task words are offered as single pieces');
  const stringRequests = provider.states.filter(state => String(state.generation.slot).startsWith('string_token:') || state.generation.slot === 'string').length;
  assert.ok(stringRequests <= 6, `a novel literal costs a handful of requests, got ${stringRequests}`);
});

test('enriched pieces keep the three-repeat stop and the 32-piece cap', async () => {
  const repeated = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'string', 'custom',
    { value: JSON.stringify('split') }, { value: JSON.stringify('split') }, { value: JSON.stringify('split') }, 'finish']);
  assert.equal(await generatePythonAst(decisions(repeated), { task: { prompt: 'Print the words banana split.' } }, 'content', options), "print('splitsplitsplit')\n");
  assert.equal(repeated.states.filter(state => String(state.generation.slot).startsWith('string_token:')).length, 3, 'the third identical piece stops the loop');

  const chars = [...'abcdefghijklmnopqrstuvwxyzABCDEF'];
  const exhausted = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'string', 'custom', ...chars.map(value => ({ value: JSON.stringify(value) }))]);
  await assert.rejects(generatePythonAst(decisions(exhausted), { task: { prompt: 'Print a value.' } }, 'content', options), /token budget exhausted/);
  assert.equal(exhausted.states.filter(state => String(state.generation.slot).startsWith('string_token:')).length, 32, 'the 32-piece cap is unchanged');
});

test('a wordy task keeps the offered pieces inside the Choice label limit and still offers the alphabet', async () => {
  const prompt = `Print ${Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ')}.`;
  const provider = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'string', 'custom', { value: JSON.stringify('z') }, 'end', 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt } }, 'content', options);
  assert.equal(source, "print('z')\n");
  const tokenAt = provider.states.findIndex(state => state.generation.slot === 'string_token:""');
  const criteria = provider.criteria[tokenAt]!;
  assert.ok(Object.keys(criteria).length <= 255, `the offered pieces stay inside the Choice label limit (${Object.keys(criteria).length})`);
  assert.ok(Object.values(criteria).includes(JSON.stringify('z')), 'the single-character alphabet survives the enrichment cap');
});

test('an over-budget custom terminal throws the existing byte-budget error', async () => {
  const words = ['zzzzzzzzzz', 'qqqqqqqqqq', 'wwwwwwwwww', 'eeeeeeeeee'];
  const provider = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'string', 'custom', ...words.map(value => ({ value: JSON.stringify(value) }))]);
  await assert.rejects(generatePythonAst(decisions(provider), { task: { prompt: `Print ${words.join(' ')}.` } }, 'content', { ...options, maxBytes: 32 }),
    /AST terminal exceeds its byte budget/);
});

test('blocks cannot repeat pass, are capped in length, identifiers never spell, and range needs an argument', async () => {
  const loop = new AstProvider(['0', 'while', 'boolean', 'true', 'pass', 'finish', 'finish']);
  assert.equal(await generatePythonAst(decisions(loop), state, 'content', options), 'while True:\n    pass\n');
  const after = loop.states.findIndex((s, i) => s.generation.slot === 'loop_body' && i > loop.states.findIndex(x => x.generation.slot === 'loop_body'));
  assert.ok(after > 0);
  assert.ok(!Object.keys(loop.criteria[after]!).includes('pass'));
  const script: Array<string | { value: string }> = ['0'];
  for (let i = 0; i < 16; i++) script.push('expr', 'call', { value: 'print' }, ...(i % 2 ? ['1', 'number', { value: '1' }] : ['0']));
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

test('lists are not offered inside list elements or call arguments, and file names in the task become string candidates', async () => {
  const provider = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'string', { value: JSON.stringify('numbers.txt') }, 'finish']);
  assert.equal(await generatePythonAst(decisions(provider), { task: { prompt: 'Write the numbers 1 to 5 to a file named numbers.txt.', turn: 1, updates: [] } }, 'content', options), "print('numbers.txt')\n");
  const argument = provider.criteria[provider.states.findIndex(s => s.generation.slot === 'argument_0')]!;
  assert.ok(!Object.hasOwn(argument, 'list'));
  const nested = new AstProvider(['0', 'expr', 'list', '1', 'number', { value: '1' }, 'finish']);
  assert.equal(await generatePythonAst(decisions(nested), state, 'content', options), '[1]\n');
  const element = nested.criteria[nested.states.findIndex(s => s.generation.slot === 'element_0')]!;
  assert.ok(!Object.hasOwn(element, 'list'));
  assert.ok(Object.hasOwn(nested.criteria[nested.states.findIndex(s => s.generation.slot === 'expression')]!, 'list'));
});

test('a call nested two levels inside call arguments is not offered a third call', async () => {
  const provider = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'call', { value: 'len' }, 'string', { value: JSON.stringify('Hello, world!') }, 'finish']);
  assert.equal(await generatePythonAst(decisions(provider), state, 'content', options), "print(len('Hello, world!'))\n");
  const slots = provider.states.map(s => s.generation.slot);
  const inner = provider.criteria[slots.lastIndexOf('argument_0')]!;
  assert.ok(!Object.hasOwn(inner, 'call'));
  assert.ok(Object.hasOwn(provider.criteria[slots.indexOf('argument_0')]!, 'call'));
});

test('builder decisions record leaf and structural path entries with monotonic ids and event fields', async () => {
  const context = createRunContext();
  const events: DecisionEventData[] = [];
  const provider = new AstProvider(['0', ...hello()]);
  const d = new Decisions(provider, 100, new AbortController().signal, async data => { events.push(data); }, 4, undefined, context);
  assert.equal(await generatePythonAst(d, state, 'content', options), "print('Hello, world!')\n");

  const path = context.pathFor(attemptScope('content'));
  assert.deepEqual(path.map(entry => [entry.questionKey, entry.kind]), [
    ['unit_count', 'structural'], ['module_body', 'structural'], ['expression', 'structural'], ['callee', 'structural'],
    ['argument_count', 'structural'], ['argument_0', 'structural'], ['string', 'leaf'], ['module_body', 'structural'],
  ]);
  assert.ok(path.every(entry => entry.alternatives.length >= 2 && entry.chosen.length > 0 && entry.identity.field === 'content'));
  for (let index = 1; index < path.length; index++) assert.ok(path[index]!.decisionId > path[index - 1]!.decisionId);
  assert.deepEqual(events.map(event => event.decisionId), path.map(entry => entry.decisionId));
  assert.ok(events.every(event => event.nearTie === false && event.field === 'content' && event.phase === 'ast'));
  assert.deepEqual(events.find(event => event.slot === 'string')!.options, path.at(-2)!.alternatives);
  assert.equal(context.decisionEntry(path[0]!.decisionId), path[0]);
  await context.dispose();
});

test('a direct generation without an explicit context uses the process default and closes it explicitly', async () => {
  const provider = new AstProvider(['0', ...hello()]);
  const d = decisions(provider);
  assert.equal(d.runContext, defaultRunContext());
  assert.equal(await generatePythonAst(d, state, 'content', options), "print('Hello, world!')\n");
  const context = d.runContext;
  assert.ok(context.pathFor(attemptScope('content')).length > 0);
  assert.equal(context.isDisposed, false);
  await closeDefaultRunContext();
  assert.equal(context.isDisposed, true);
  assert.throws(() => context.allocateDecisionId(), /disposed/);
});

test('sibling call arguments batch into one wave with per-question identity and one request', async () => {
  const context = createRunContext();
  const events: DecisionEventData[] = [];
  const provider = new AstProvider(['0', 'import', 'math', 'expr', 'call', { value: 'print' }, '1', 'call', 'member', { value: 'math' },
    'gcd', 'number', 'number', { value: '12' }, { value: '8' }, 'finish']);
  const d = new Decisions(provider, 100, new AbortController().signal, async data => { events.push(data); }, 4, undefined, context);
  const source = await generatePythonAst(d, { task: { prompt: 'Python import math and print math.gcd(12, 8).' } }, 'content', options);
  assert.equal(source, 'import math\nprint(math.gcd(12, 8))\n');

  assert.deepEqual(provider.asked, [
    ['unit_count'], ['module_body'], ['module'], ['module_body'], ['expression'], ['callee'], ['argument_count'], ['argument_0'],
    ['callee'], ['receiver'], ['member'], ['argument_0', 'argument_1'], ['number'], ['number'], ['module_body'],
  ], 'the callee is asked alone, the count is a post-callee single, and the sibling arguments batch');
  assert.equal(provider.asked.filter(keys => keys.includes('argument_count')).length, 1, 'only print asks for a count; the known gcd arity is host-derived');
  const waveState = provider.states[provider.asked.findIndex(keys => keys.length > 1)]!;
  assert.equal(waveState.generation.slot, undefined, 'a wave state carries no single slot; questions carry their own');

  const path = context.pathFor(attemptScope('content'));
  const memberAt = path.findIndex(entry => entry.questionKey === 'member');
  const siblings = path.slice(memberAt).filter(entry => /^argument_[01]$/.test(entry.questionKey));
  assert.deepEqual(siblings.map(entry => [entry.questionKey, entry.chosen, entry.kind]),
    [['argument_0', 'number', 'structural'], ['argument_1', 'number', 'structural']]);
  assert.deepEqual(siblings.map(entry => entry.identity.slot), ['argument_0', 'argument_1'], 'each wave question records its own slot');
  assert.ok(siblings.every(entry => entry.identity.field === 'content' && entry.identity.phase === 'ast'));
  assert.equal(new Set(siblings.map(entry => entry.decisionId)).size, 2, 'wave questions get distinct decision ids');

  const waveEvents = events.filter(event => event.wave !== undefined);
  assert.equal(waveEvents.length, 2);
  assert.equal(new Set(waveEvents.map(event => event.wave)).size, 1, 'one wave id for the whole request');
  assert.deepEqual(waveEvents.map(event => event.slot), ['argument_0', 'argument_1']);
  assert.deepEqual(waveEvents.map(event => event.decisionId), siblings.map(entry => entry.decisionId));
  assert.ok(events.some(event => event.wave === undefined && event.choice !== undefined), 'single questions carry no wave id');
  await context.dispose();
});

test('binary and compare children batch into one wave before either child is filled', async () => {
  const provider = new AstProvider(['0', 'expr', 'call', { value: 'print' }, '1', 'binary', 'Add', 'number', 'number', { value: '1' }, { value: '2' }, 'finish']);
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Python print 1 plus 2.' } }, 'content', options);
  assert.equal(source, 'print(1 + 2)\n');
  assert.deepEqual(provider.asked, [
    ['unit_count'], ['module_body'], ['expression'], ['callee'], ['argument_count'], ['argument_0'], ['operator'],
    ['left', 'right'], ['number'], ['number'], ['module_body'],
  ], 'one wave answers both children after the operator');
  const operatorAt = provider.slots.findIndex(slot => slot === 'operator');
  assert.deepEqual(provider.slots.slice(operatorAt + 1, operatorAt + 3), ['left', 'right'], 'both children are asked before either is filled');
});

test('a wave question isolated by bisection is journaled through the note hook', async () => {
  const notes: string[] = [];
  const inner = new AstProvider(['0', 'import', 'math', 'expr', 'call', { value: 'print' }, '1', 'call', 'member', { value: 'math' },
    'gcd', 'number', 'number', { value: '12' }, { value: '8' }, 'finish']);
  // The wave-shaped request for argument_1 is rejected (422); the plain single-question shape succeeds.
  const provider: DecisionProvider = { decide: async (input, questions, signal) => {
    if (Object.keys(questions).includes('argument_1')) throw Object.assign(new Error('Jev rejected the request (422).'), { status: 422 });
    return inner.decide(input, questions, signal);
  } };
  const source = await generatePythonAst(decisions(provider), { task: { prompt: 'Python import math and print math.gcd(12, 8).' } }, 'content',
    { ...options, note: async message => { notes.push(message); } });
  assert.equal(source, 'import math\nprint(math.gcd(12, 8))\n');
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /^Wave question argument_1 was skipped after a provider rejection and asked singly \(Jev rejected the request \(422\)\.\)\.$/);
});

const waveAnswer = (criteria: Record<string, string>, selected: string): unknown => ({
  type: 'choice', choice: selected, confidence: 1,
  probabilities: Object.fromEntries(Object.keys(criteria).map(label => [label, label === selected ? 1 : 0])),
});

const firstLabelAnswer = (questions: Questions): Record<string, unknown> =>
  Object.fromEntries(Object.entries(questions).map(([key, question]) => [key,
    waveAnswer(question.type === 'choice' ? question.criteria as Record<string, string> : {}, Object.keys((question.criteria ?? {}) as Record<string, string>)[0]!)]));

test('a wave over the byte budget pre-splits into one request per part', async () => {
  const calls: string[][] = [];
  const provider: DecisionProvider = { decide: async (_state, questions) => {
    calls.push(Object.keys(questions));
    return { model: 'wave-fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: firstLabelAnswer(questions) } as never;
  } };
  const d = new Decisions(provider, 100, new AbortController().signal, undefined, 4, undefined, createRunContext());
  const huge = 'x'.repeat(15_000);
  const answers = await d.chooseWave({ task: { prompt: 'x' } }, {
    a: { instruction: 'A', criteria: { x: huge, y: 'Y' } },
    b: { instruction: 'B', criteria: { x: huge, y: 'Y' } },
  }, { scope: attemptScope('content') });
  assert.deepEqual(calls, [['a'], ['b']], 'each part is its own wave request');
  assert.equal(answers.a!.choice, 'x');
  assert.equal(answers.b!.choice, 'x');
  assert.notEqual(answers.a!.decisionId, answers.b!.decisionId);
  assert.equal(d.requests, 2);
  await d.runContext.dispose();
});

test('a single-label wave question is host-derived and never sent', async () => {
  const calls: string[][] = [];
  const provider: DecisionProvider = { decide: async (_state, questions) => {
    calls.push(Object.keys(questions));
    return { model: 'wave-fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: firstLabelAnswer(questions) } as never;
  } };
  const d = new Decisions(provider, 100, new AbortController().signal, undefined, 4, undefined, createRunContext());
  const answers = await d.chooseWave({}, {
    solo: { instruction: 'S', criteria: { only: 'Only.' } },
    pair: { instruction: 'P', criteria: { x: 'X.', y: 'Y.' } },
  }, { scope: attemptScope('content') });
  assert.equal(answers.solo!.choice, 'only');
  assert.equal(answers.solo!.decisionId, undefined, 'a host-derived question records no decision');
  assert.deepEqual(calls, [['pair']], 'only the two-label question is sent');
  await d.runContext.dispose();
});

test('a rejected wave bisects until the bad question is isolated and falls back to a single question', async () => {
  const calls: string[][] = [];
  const skipped: string[] = [];
  // The wave-shaped request for `bad` is rejected (422); the plain single-question shape succeeds.
  const provider: DecisionProvider = { decide: async (_state, questions) => {
    const keys = Object.keys(questions);
    calls.push(keys);
    const bad = Object.entries(questions).some(([, question]) => question.type === 'choice' && Object.hasOwn(question.criteria ?? {}, 'b1'));
    if (bad && keys[0] !== 'selection') throw Object.assign(new Error('Jev rejected the request (422).'), { status: 422 });
    return { model: 'wave-fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: firstLabelAnswer(questions) } as never;
  } };
  const d = new Decisions(provider, 100, new AbortController().signal, undefined, 4, undefined, createRunContext());
  const answers = await d.chooseWave({}, {
    good: { instruction: 'G', criteria: { g1: 'G1.', g2: 'G2.' } },
    bad: { instruction: 'B', criteria: { b1: 'B1.', b2: 'B2.' } },
  }, { scope: attemptScope('content'), onSkip: async (question, detail) => { skipped.push(`${question}: ${detail}`); } });
  assert.deepEqual(calls, [['good', 'bad'], ['good'], ['bad'], ['selection']], 'the wave bisects to the bad question, then asks it singly');
  assert.equal(answers.good!.choice, 'g1');
  assert.equal(answers.bad!.choice, 'b1');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0]!, /^bad: Jev rejected the request \(422\)\.$/);
  assert.equal(d.runContext.isWaveShapeBlacklisted('bad'), false, 'one isolation does not blacklist the shape');
  await d.runContext.dispose();
});

test('a skipped question whose single fallback also fails fails the unit loudly', async () => {
  const calls: string[][] = [];
  const provider: DecisionProvider = { decide: async (_state, questions) => {
    calls.push(Object.keys(questions));
    if (Object.entries(questions).some(([, question]) => question.type === 'choice' && Object.hasOwn(question.criteria ?? {}, 'b1'))) {
      throw Object.assign(new Error('Jev rejected the request (422).'), { status: 422 });
    }
    return { model: 'wave-fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: firstLabelAnswer(questions) } as never;
  } };
  const d = new Decisions(provider, 100, new AbortController().signal, undefined, 4, undefined, createRunContext());
  await assert.rejects(d.chooseWave({}, {
    good: { instruction: 'G', criteria: { g1: 'G1.', g2: 'G2.' } },
    bad: { instruction: 'B', criteria: { b1: 'B1.', b2: 'B2.' } },
  }, { scope: attemptScope('content') }), /Wave question bad was skipped after a provider rejection and its single-question fallback failed: Jev rejected the request \(422\)\./);
  assert.deepEqual(calls, [['good', 'bad'], ['good'], ['bad'], ['selection']]);
  await d.runContext.dispose();
});

test('a 5xx wave failure surfaces without bisection and a repeat bisection blacklists the shape', async () => {
  let calls = 0;
  const fatal: DecisionProvider = { decide: async () => { calls++; throw Object.assign(new Error('internal server error'), { status: 500 }); } };
  const fatalDecisions = new Decisions(fatal, 100, new AbortController().signal, undefined, 4, undefined, createRunContext());
  await assert.rejects(fatalDecisions.chooseWave({}, {
    a: { instruction: 'A', criteria: { a1: 'A1.', a2: 'A2.' } },
    b: { instruction: 'B', criteria: { b1: 'B1.', b2: 'B2.' } },
  }, { scope: attemptScope('content') }), /internal server error/);
  assert.equal(calls, 1, 'a fatal failure is not bisected');
  await fatalDecisions.runContext.dispose();

  const calls2: string[][] = [];
  const provider: DecisionProvider = { decide: async (_state, questions) => {
    const keys = Object.keys(questions);
    calls2.push(keys);
    const bad = Object.entries(questions).some(([, question]) => question.type === 'choice' && Object.hasOwn(question.criteria ?? {}, 'b1'));
    if (bad && keys[0] !== 'selection') throw Object.assign(new Error('Jev rejected the request (422).'), { status: 422 });
    return { model: 'wave-fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: firstLabelAnswer(questions) } as never;
  } };
  const d = new Decisions(provider, 100, new AbortController().signal, undefined, 4, undefined, createRunContext());
  const wave = (): Promise<Record<string, { choice: string }>> => d.chooseWave({}, {
    good: { instruction: 'G', criteria: { g1: 'G1.', g2: 'G2.' } },
    bad: { instruction: 'B', criteria: { b1: 'B1.', b2: 'B2.' } },
  }, { scope: attemptScope('content') });
  await wave();
  assert.equal(d.runContext.isWaveShapeBlacklisted('bad'), false);
  await wave();
  assert.equal(d.runContext.isWaveShapeBlacklisted('bad'), true, 'the second isolation blacklists the shape');
  const before = calls2.length;
  await wave();
  const later = calls2.slice(before);
  assert.ok(later.every(keys => !(keys.includes('bad') && keys.includes('good'))), `a blacklisted shape never joins a wave: ${JSON.stringify(later)}`);
  assert.deepEqual(later, [['selection'], ['good']], 'the blacklisted question is asked singly and the rest still batch');
  await d.runContext.dispose();
});

test('the wave budget pre-check covers the singles worst case plus bisection overhead', async () => {
  let calls = 0;
  const provider: DecisionProvider = { decide: async (_state, questions) => {
    calls++;
    return { model: 'wave-fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: firstLabelAnswer(questions) } as never;
  } };
  const questions = {
    a: { instruction: 'A', criteria: { a1: 'A1.', a2: 'A2.' } },
    b: { instruction: 'B', criteria: { b1: 'B1.', b2: 'B2.' } },
    c: { instruction: 'C', criteria: { c1: 'C1.', c2: 'C2.' } },
  };
  const tight = new Decisions(provider, 4, new AbortController().signal, undefined, 4, undefined, createRunContext());
  await assert.rejects(tight.chooseWave({}, questions, { scope: attemptScope('content') }), /Request budget exhausted \(4\)\./);
  assert.equal(calls, 0, 'the wave was not sent');
  await tight.runContext.dispose();

  const fits = new Decisions(provider, 5, new AbortController().signal, undefined, 4, undefined, createRunContext());
  const answers = await fits.chooseWave({}, questions, { scope: attemptScope('content') });
  assert.equal(Object.keys(answers).length, 3);
  assert.equal(calls, 1, 'the wave itself is one request');
  assert.equal(fits.requests, 1);
  await fits.runContext.dispose();
});
