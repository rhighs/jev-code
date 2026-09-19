import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createPrinter, printRun } from '../src/print.js';
import { renderItem, renderLive, renderSummary } from '../src/render-plain.js';
import { initialState, reduce, type Decision, type Item, type ToolItem } from '../src/transcript.js';
import type { HarnessEvent, HarnessEventData, ToolRecord } from '../src/types.js';
import { ScriptedProvider } from './helpers.js';

const off = { color: false };
const tool = (over: Partial<ToolItem>): ToolItem =>
  ({ kind: 'tool', turn: 1, status: 'done', tool: 'write_file', target: 'hello.py', startedMs: 0, durationMs: 12, requests: 1, ...over });
const summary = (over: Partial<Extract<Item, { kind: 'summary' }>> = {}): Extract<Item, { kind: 'summary' }> => ({
  kind: 'summary', status: 'completed', reason: '', facts: ['Wrote hello.py.', 'Bash exited with code 0.'], omitted: 0,
  turns: 2, requests: 4, limits: { turns: 50, requests: 512 }, usage: { inputTokens: 10, outputTokens: 2 }, durationMs: 500, runId: 'r1', ...over,
});

let clock = 0;
const ev = <K extends keyof HarnessEventData>(type: K, data: HarnessEventData[K], turn = 1): HarnessEvent =>
  ({ type, data, runId: 'r', timestamp: 't', elapsedMs: (clock += 10), turn }) as HarnessEvent;
const start = (): HarnessEvent => ev('start', { schema: 1, prompt: 'Write hello.py', workspace: '/ws', decoder: 'dynamic', limits: { turns: 50, requests: 512 }, journal: null }, 0);
const text = (field: string, value: string, ast?: { slot: string; production: string; unit?: string }, done = false): HarnessEvent =>
  ev('text', { field, bytes: value.length, done, change: { replace: value }, decoder: ast ? 'ast' : 'choice', step: 1, cursor: { row: 0, column: 0, offset: 0 }, ...(ast ? { ast: { symbols: [], ...ast } } : {}) });
const record = (tool: string, args: ToolRecord['args'], ok: boolean, output: string, data?: Record<string, unknown>): ToolRecord => ({ turn: 1, tool, args, result: { ok, output, ...(data ? { data } : {}) } });

const collect = (stream: PassThrough): (() => string) => { let text = ''; stream.on('data', d => { text += String(d); }); return () => text; };
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

test('prompt, turn and update rows', () => {
  assert.deepEqual(renderItem({ kind: 'prompt', text: 'Write hello.py\nwith tests' }, off), ['› Write hello.py', '  with tests']);
  assert.deepEqual(renderItem({ kind: 'turn', turn: 1, files: 0, plan: '' }, off), ['── turn 1 · 0 files']);
  assert.deepEqual(renderItem({ kind: 'turn', turn: 2, files: 1, plan: 'Write tests\nthen run' }, off), ['── turn 2 · 1 file · plan: Write tests']);
  assert.deepEqual(renderItem({ kind: 'update', text: 'Also add tests.' }, off), ['↳ update · Also add tests.']);
});

test('write card: numbered clipped source with the remaining count and hint', () => {
  const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
  const card = tool({ body: { kind: 'source', path: 'hello.py', lines, remaining: 6, hint: '/show hello.py' } });
  assert.deepEqual(renderItem(card, off), [
    '✓ write_file hello.py · 12 ms · 1 req',
    '  │   1  line 1', '  │   2  line 2', '  │   3  line 3', '  │   4  line 4',
    '  │   5  line 5', '  │   6  line 6', '  │   7  line 7', '  │   8  line 8',
    '  │ … 6 more lines · /show hello.py',
  ]);
  const colored = renderItem(tool({ body: { kind: 'source', path: 'a.py', lines: ['x = 1'], remaining: 0, hint: '/show a.py' } }), { color: true });
  assert.match(colored[0]!, /^\x1b\[32m/);
  assert.match(colored[1]!, /\x1b\[35m1\x1b\[0m/);
});

test('edit card: marked hunk lines (AE1)', () => {
  const card = tool({ tool: 'edit_file', target: 'main.py', durationMs: 3, requests: 0,
    body: { kind: 'diff', path: 'main.py', hunk: [{ kind: 'context', text: 'x = 1' }, { kind: 'remove', text: "print('Correct', None)" }, { kind: 'add', text: "print('Correct')" }, { kind: 'skip', text: '3 unchanged lines' }] } });
  assert.deepEqual(renderItem(card, off), ['✓ edit_file main.py · 3 ms · 0 req', '  │  x = 1', "  │ -print('Correct', None)", "  │ +print('Correct')", '  │ …3 unchanged lines']);
});

test('run card: command, exit code, duration, clipped output; failed, denied and awaiting statuses', () => {
  const run = tool({ tool: 'bash', target: 'cat hello.txt', exitCode: 0, durationMs: 8, requests: 2, body: { kind: 'output', lines: ['hello', 'world'], remaining: 3 } });
  assert.deepEqual(renderItem(run, off), ['✓ bash cat hello.txt · exit 0 · 8 ms · 2 req', '  │ hello', '  │ world', '  │ … 3 more lines']);
  const failed = tool({ tool: 'bash', target: 'cat missing', status: 'failed', exitCode: 1, durationMs: 8, requests: 2, body: { kind: 'output', lines: ['cat: missing: No such file'], remaining: 0 } });
  assert.deepEqual(renderItem(failed, off), ['✗ bash cat missing · failed · exit 1 · 8 ms · 2 req', '  │ cat: missing: No such file']);
  const denied = tool({ tool: 'bash', target: 'rm -rf build', status: 'denied', durationMs: 0, requests: 0, body: { kind: 'output', lines: ['Host declined this tool call.'], remaining: 0 } });
  assert.deepEqual(renderItem(denied, off), ['⊘ bash rm -rf build · denied · 0 ms · 0 req', '  │ Host declined this tool call.']);
  const { durationMs: _d, ...awaiting } = tool({ tool: 'bash', target: 'rm -rf build', status: 'awaiting', requests: 0 });
  assert.deepEqual(renderItem(awaiting, off), ['? bash rm -rf build · needs approval · 0 req']);
  const noisy = tool({ tool: 'bash', target: 'ls', exitCode: 0, body: { kind: 'output', lines: ['\x1b[31mred\x1b[0m\tx'], remaining: 0 } });
  assert.deepEqual(renderItem(noisy, off)[1], '  │ red    x');
});

test('multi-file card lists paths with the remaining count', () => {
  const card = tool({ tool: 'write_files', target: '3 files', body: { kind: 'paths', paths: ['main.py', 'pkg/__init__.py'], remaining: 1 } });
  assert.deepEqual(renderItem(card, off), ['✓ write_files 3 files · 12 ms · 1 req', '  │ main.py', '  │ pkg/__init__.py', '  │ … 1 more file']);
});

test('propose card renders the provider line and the selection', () => {
  const args = { kind: 'text', path: '', objective: 'name it', constraints: '', count: 3 };
  const output = 'provider=fake model=tiny\nA valid 5 bytes\nB invalid: fenced\nselected A 0.90\n\nhello';
  const state = [start(), ev('action', { tool: 'propose' }), ev('tool_start', { tool: 'propose', args }),
    ev('tool_end', record('propose', args, true, output, { provider: 'fake', model: 'tiny', kind: 'text', selected: 'A', confidence: 0.9 }))].reduce(reduce, initialState());
  const card = state.items.find((item): item is ToolItem => item.kind === 'tool')!;
  const lines = renderItem(card, off);
  assert.match(lines[0]!, /^✓ propose text/);
  assert.ok(lines.some(line => line.includes('provider=fake model=tiny')));
  assert.ok(lines.some(line => line.includes('selected A 0.90')));
  const file = tool({ tool: 'propose', target: 'x.py', body: { kind: 'diff', path: 'x.py', hunk: [{ kind: 'remove', text: '  return 1' }, { kind: 'add', text: '  return 2' }] } });
  assert.deepEqual(renderItem(file, off), ['✓ propose x.py · 12 ms · 1 req', '  │ -  return 1', '  │ +  return 2']);
});

test('trace card lists choices with probabilities and alternatives (AE2)', () => {
  const decisions: Decision[] = [
    { turn: 1, choice: 'Expr', confidence: 0.9, options: [{ label: 'Expr', probability: 0.41 }, { label: 'Assign', probability: 0.39 }, { label: 'Return', probability: 0.2 }], lowConfidence: true, field: 'content', slot: 'stmt' },
    { turn: 1, choice: 'write_file', options: [{ label: 'write_file', probability: 1 }], lowConfidence: false },
    { turn: 1, choice: 'return', options: [], lowConfidence: false, field: 'content', slot: 'function_body', unit: 'greet' },
  ];
  assert.deepEqual(renderItem({ kind: 'trace', decisions }, off), [
    'trace · 3 decisions',
    '  stmt → Expr · 41% · low confidence · alt Assign 39%, Return 20%',
    '  action → write_file · 100%',
    '  greet · function_body → return',
  ]);
  assert.deepEqual(renderItem({ kind: 'trace', decisions: [] }, off), ['trace · no decisions']);
});

test('summary block has a fixed shape', () => {
  assert.deepEqual(renderSummary(summary()), ['[completed]', '  Wrote hello.py.', '  Bash exited with code 0.', '500 ms · 2/50 turns · 4/512 requests · 12 tokens · run r1']);
  const { limits: _l, ...error } = summary({ status: 'error', reason: 'Boom.', facts: [], turns: 1, requests: 1, durationMs: 20 });
  assert.deepEqual(renderSummary(error), ['[error]', '  Boom.', '20 ms · 1 turn · 1 request · 12 tokens · run r1']);
  assert.deepEqual(renderSummary(summary({ omitted: 3, reason: 'Because.' })), ['[completed]', '  Wrote hello.py.', '  Bash exited with code 0.', '  3 more outcomes in the run log.', '  Because.', '500 ms · 2/50 turns · 4/512 requests · 12 tokens · run r1']);
  assert.deepEqual(renderItem(summary(), off), renderSummary(summary()));
});

test('live area shows the file being built and the decision strip', () => {
  const state = [start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'write_file' }), text('path', 'hello.py', undefined, true),
    text('content', 'def greet(name):\n    __jev_pending__\n', { slot: 'function_body', production: 'return', unit: 'greet' }),
    ev('decision', { model: 'm', choice: 'return', confidence: 1, field: 'content', slot: 'function_body', unit: 'greet', options: [{ label: 'return', probability: 0.8 }, { label: 'expr', probability: 0.2 }] }),
  ].reduce(reduce, initialState());
  assert.ok(state.live);
  assert.deepEqual(renderLive(state.live, state, off), [
    '◔ write_file hello.py · generating · 1 req',
    '  │   1  def greet(name):',
    '  │   2      __jev_pending__',
    '  function_body → return · 80% · 1 req',
  ]);
});

test('non-TTY generation prints one step line per production and the source once (R23)', () => {
  const stderr = new PassThrough();
  const err = collect(stderr);
  const { onEvent } = createPrinter(stderr);
  const lines = Array.from({ length: 14 }, (_, i) => `x${i + 1} = ${i + 1}`);
  const content = lines.join('\n') + '\n';
  for (const e of [start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'write_file' }), text('path', 'hello.py', undefined, true)]) onEvent(e);
  for (let i = 1; i <= 14; i++) onEvent(text('content', lines.slice(0, i).join('\n') + '\n__jev_pending__\n', { slot: 'module_body', production: 'assign' }));
  onEvent(text('content', content, undefined, true));
  onEvent(ev('tool_start', { tool: 'write_file', args: { path: 'hello.py', content } }));
  onEvent(ev('tool_end', record('write_file', { path: 'hello.py', content }, true, 'Wrote hello.py.', { path: '/ws/hello.py', bytes: content.length })));
  onEvent(ev('end', { status: 'completed', summary: 'Wrote hello.py.', modelSummary: null, turns: 1, requests: 14, usage: { inputTokens: 1, outputTokens: 0 }, startedAt: 'a', endedAt: 'b', durationMs: 5 }));
  assert.equal(count(err(), '  module_body → assign\n'), 14);
  assert.equal(count(err(), '✓ write_file hello.py'), 1);
  assert.equal(count(err(), 'x1 = 1'), 1);
  assert.equal(count(err(), 'x8 = 8'), 1);
  assert.equal(count(err(), '__jev_pending__'), 0);
  assert.equal(count(err(), '… 6 more lines'), 1);
  assert.equal(count(err(), '[completed]'), 0);
});

test('--print keeps cards on stderr once and only the summary on stdout, with no escape codes (AE4)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-print-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = await realpath(root);
  const content = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const provider = new ScriptedProvider([{ action: 'write_file', args: { path: 'hello.txt', content } }, { action: 'finish', verdict: 1 }]);
  const stdout = new PassThrough(), stderr = new PassThrough();
  const out = collect(stdout), err = collect(stderr);
  const result = await printRun({ harness: { workspace: ws, provider, experimentalGrid: true, journalDirectory: false }, prompt: 'Write hello.txt.',
    stdin: new PassThrough(), stdout, stderr, yes: true, confirmWrites: false, json: false, signal: new AbortController().signal });
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(count(err(), '✓ write_file hello.txt'), 1);
  assert.equal(count(err(), '  │   1  line 1\n'), 1);
  assert.equal(count(err(), '  │   8  line 8\n'), 1);
  assert.equal(count(err(), 'line 9'), 0);
  assert.equal(count(err(), '… 6 more lines · /show hello.txt'), 1);
  assert.match(err(), /^› Write hello\.txt\.\n── turn 1 · 0 files\n/);
  assert.doesNotMatch(err(), /\x1b\[/);
  assert.doesNotMatch(out(), /\x1b\[/);
  assert.match(out(), new RegExp(`^\\[completed\\]\\n  Wrote hello\\.txt\\.\\n\\d+ ms · 2/50 turns · \\d+/512 requests · \\d+ tokens · run ${result.id}\\n$`));
});

test('the one-shot approval prompt renders the awaiting card before asking', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-print-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = await realpath(root);
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'hello.txt', content: 'hello\n' } },
    { action: 'bash', args: { command: 'cat hello.txt', cwd: '.', timeout_ms: '' } },
    { action: 'finish', verdict: 1 },
  ]);
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = new PassThrough(), stderr = new PassThrough();
  const out = collect(stdout), err = collect(stderr);
  stderr.on('data', () => { if (err().includes('Execute? [y/N]') && !err().includes('✓ bash')) stdin.write('y\n'); });
  const result = await printRun({ harness: { workspace: ws, provider, experimentalGrid: true, journalDirectory: false }, prompt: 'Write hello and cat it.',
    stdin, stdout, stderr, yes: false, confirmWrites: false, json: false, signal: new AbortController().signal });
  assert.equal(result.status, 'completed', result.summary);
  const card = err().indexOf('? bash cat hello.txt · needs approval'), ask = err().indexOf('Execute? [y/N]');
  assert.ok(card >= 0 && ask > card, err());
  assert.match(err(), /✓ bash cat hello\.txt · exit 0/);
  assert.match(out(), /^\[completed\]\n  Wrote hello\.txt\.\n  Bash exited with code 0\.\n/);
});

test('a running command shows its last output lines in the live area, and a narrow pane keeps only the strip', () => {
  const events = [start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'bash' }), ev('tool_start', { tool: 'bash', args: { command: 'python3 -m http.server' } })];
  const state = [...events, ...Array.from({ length: 8 }, (_, i) => ev('tool_output', { stream: 'stdout' as const, text: `line ${i + 1}\n` }))].reduce(reduce, initialState());
  assert.ok(state.live);
  const pane = renderLive(state.live, state, off);
  assert.equal(pane[0], '◐ bash python3 -m http.server · running · 0 req');
  assert.deepEqual(pane.slice(1, -1), ['  │ line 3', '  │ line 4', '  │ line 5', '  │ line 6', '  │ line 7', '  │ line 8']);
  assert.deepEqual(renderLive(state.live, state, off, 0), ['  choosing…']);
});

test('the awaiting card renders in full, untruncated, even on a narrow pane', () => {
  const command = `echo ${'a'.repeat(100)}\ntouch x`;
  const state = [start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'bash' }), { type: 'permission' as const, data: { tool: 'bash', args: { command } } }].reduce(reduce, initialState());
  assert.ok(state.live);
  const pane = renderLive(state.live, state, { color: false, width: 40 }, 0);
  assert.equal(pane[0], `? bash echo ${'a'.repeat(100)} … · needs approval · 0 req`);
  assert.equal(pane[1], `  │ echo ${'a'.repeat(100)}`);
  assert.equal(pane[2], '  │ touch x');
});

test('--print streams running output as it arrives and prints the finished card once without repeating the body', () => {
  const stderr = new PassThrough();
  const err = collect(stderr);
  const { onEvent } = createPrinter(stderr);
  for (const e of [start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'bash' }), ev('tool_start', { tool: 'bash', args: { command: 'printf ready' } })]) onEvent(e);
  onEvent(ev('tool_output', { stream: 'stdout', text: 'Server ready at http://localhost:3000\npar' }));
  onEvent(ev('tool_output', { stream: 'stdout', text: 'tial\n' }));
  onEvent(ev('tool_end', record('bash', { command: 'printf ready' }, true, 'Server ready at http://localhost:3000\npartial\n', { exitCode: 0 })));
  assert.equal(count(err(), 'Server ready at http://localhost:3000'), 1);
  assert.equal(count(err(), '  │ partial'), 1);
  assert.equal(count(err(), '✓ bash printf ready · exit 0'), 1);
  assert.ok(err().indexOf('Server ready') < err().indexOf('✓ bash printf ready'));
});
