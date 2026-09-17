import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateBashAst, renderBashAst, validateBashSource, type BashAst } from '../src/bash-ast.js';
import { Decisions } from '../src/decisions.js';
import type { DecisionProvider } from '../src/types.js';

const execute = promisify(execFile);
const command = (program: string, ...args: string[]): BashAst => ({ type: 'command', program, args, redirects: [] });
const options = { maxSteps: 40, maxBytes: 8000, allowEmpty: false, fragments: [] };
function fixture(script: Array<string | { label: string }>): DecisionProvider {
  return { decide: async (input, questions) => {
    assert.equal((input as unknown as { generation: { phase: string } }).generation.phase, 'bash_ast');
    const question = questions.selection!;
    if (question.type !== 'choice') throw new Error('Expected Choice');
    const next = script.shift();
    assert.ok(next, 'Unexpected AST decision');
    const selected = typeof next === 'string' ? next : Object.entries(question.criteria).find(([, label]) => label === next.label)?.[0];
    assert.ok(selected && Object.hasOwn(question.criteria, selected), `Unavailable production ${JSON.stringify(next)}`);
    return { model: 'bash-ast-fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: { selection: { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selected)])) } } } as never;
  } };
}

test('Bash AST quotes literal words and preserves mixed operator tree grouping', async () => {
  const text = "hello'; echo unexpected; $(printf bad)";
  assert.equal((await execute('bash', ['-c', renderBashAst(command('printf', '%s', text))])).stdout, text);
  const tree: BashAst = { type: 'binary', operator: '|', left: { type: 'binary', operator: '&&', left: command('printf', 'first'), right: command('printf', 'second') }, right: command('cat') };
  const source = renderBashAst(tree);
  await validateBashSource(source, new AbortController().signal);
  assert.match(source, /^\{ /);
  assert.equal((await execute('bash', ['-c', source])).stdout, 'firstsecond');
});

test('Bash AST composes programs, arguments and pipelines entirely with choices', async () => {
  const provider = fixture([{ label: 'printf' }, { label: JSON.stringify('hello') }, 'END', 'pipe', { label: 'cat' }, 'END', 'END']);
  const events: Array<{ value: string; done: boolean; decoder: string | undefined }> = [];
  const source = await generateBashAst(new Decisions(provider, 30, new AbortController().signal), { task: { prompt: 'Print "hello" using printf and pipe it to cat.' } }, 'command', { ...options, onText: async (_field, value, done, _change, progress) => { events.push({ value, done, decoder: progress?.decoder }); } });
  assert.equal(source, "'printf' 'hello' | 'cat'");
  assert.equal((await execute('bash', ['-c', source])).stdout, 'hello');
  assert.ok(events.every(event => event.decoder === 'ast'));
  assert.equal(events.at(-1)?.done, true);
});

test('Bash AST selects a complete verification tree in one request', async () => {
  const decisions = new Decisions(fixture([{ label: "'python3' 'main.py'" }]), 5, new AbortController().signal);
  const source = await generateBashAst(decisions, { task: { prompt: 'Run main.py to verify Python.' } }, 'command', options);
  assert.equal(source, "'python3' 'main.py'");
  assert.equal(decisions.requests, 1);
});

test('Bash syntax validation never executes source, and AST budget and cancellation stop generation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-bash-ast-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await validateBashSource(`touch '${join(root, 'must-not-exist')}'`, new AbortController().signal);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(validateBashSource('if ; then', new AbortController().signal), /syntax validation/);
  await assert.rejects(generateBashAst(new Decisions(fixture(['compose']), 5, new AbortController().signal), { task: { prompt: 'Print hello.' } }, 'command', { ...options, maxSteps: 1 }), /production budget/);
  await assert.rejects(generateBashAst(new Decisions(fixture([]), 5, AbortSignal.abort(new Error('Stop'))), {}, 'command', options), /Stop/);
});
