/** @jsxRuntime automatic @jsxImportSource react */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify, stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import type { HarnessOptions } from '../src/harness.js';
import type { DecisionProvider, HarnessEvent, HarnessEventData } from '../src/types.js';
import { App } from '../src/ui/app.js';
import { createSession, isInteractiveTTY, type SessionOptions } from '../src/ui/session.js';
import { ScriptedProvider } from './helpers.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

let clock = 0;
const ev = <K extends keyof HarnessEventData>(type: K, data: HarnessEventData[K], turn = 1): HarnessEvent =>
  ({ type, data, runId: 'r', timestamp: 't', elapsedMs: (clock += 10), turn }) as HarnessEvent;
const text = (field: string, value: string, ast?: { slot: string; production: string }): HarnessEvent =>
  ev('text', { field, bytes: value.length, done: false, change: { replace: value }, decoder: ast ? 'ast' : 'choice', step: 1, cursor: { row: 0, column: 0, offset: 0 }, ...(ast ? { ast: { symbols: [], ...ast } } : {}) });
const generating = (): HarnessEvent[] => [
  ev('start', { schema: 1, prompt: 'Write hello.py', workspace: '/ws', decoder: 'dynamic', limits: { turns: 50, requests: 512 }, journal: null }, 0),
  ev('turn', { files: 0, plan: '' }),
  ev('decision', { model: 'm', choice: 'write_file', confidence: 1, options: [{ label: 'write_file', probability: 1 }] }),
  ev('action', { tool: 'write_file' }),
  text('path', 'hello.py'),
  ev('decision', { model: 'm', choice: 'expr', confidence: 0.9, options: [{ label: 'expr', probability: 0.41 }, { label: 'assign', probability: 0.39 }], field: 'content', phase: 'ast', slot: 'module_body' }),
  text('content', 'x = 1\n__jev_pending__\n', { slot: 'module_body', production: 'expr' }),
];

const stall = (base: DecisionProvider): DecisionProvider => ({
  decide: async (state, questions, signal) => {
    await new Promise<void>((_, reject) => { signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    return base.decide(state, questions, signal);
  },
});

async function setup(t: test.TestContext, provider: DecisionProvider, extra: Partial<SessionOptions> = {}, harness: Partial<HarnessOptions> = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'jev-ui-'));
  const session = createSession({ harness: { experimentalGrid: true, workspace, provider, journalDirectory: false, ...harness }, model: 'test-jev', yes: true, tty: true, ...extra });
  const ui = render(<App session={session} />);
  await new Promise(resolve => setTimeout(resolve, 10));
  t.after(async () => { session.close(0); await session.closed; ui.unmount(); await rm(workspace, { recursive: true, force: true }); });
  const frame = (): string => stripVTControlCharacters(ui.lastFrame() ?? '');
  const wait = (re: RegExp): Promise<string> => new Promise((done, fail) => {
    const started = Date.now();
    const check = (): void => {
      if (re.test(frame())) return done(frame());
      if (Date.now() - started > 4000) return fail(new Error(`Missing ${re} in frame:\n${frame()}`));
      setTimeout(check, 10);
    };
    check();
  });
  const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));
  const type = async (line: string): Promise<void> => { ui.stdin.write(line); await tick(); ui.stdin.write('\r'); await tick(); };
  return { session, ui, workspace, frame, wait, type };
}

const lines = (frame: string): string[] => frame.trimEnd().split('\n');

test('a scripted run renders one row per completed item in order and ends with the status line and prompt', async t => {
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'hello.txt', content: 'hello\nworld\n' } },
    { action: 'finish', args: { summary: 'Wrote hello.txt.' } },
  ]);
  const { type, wait, frame, workspace } = await setup(t, provider);
  await type('Create hello.txt.');
  const done = await wait(/\[completed\]/);
  assert.equal(await readFile(join(workspace, 'hello.txt'), 'utf8'), 'hello\nworld\n');
  const order = ['› Create hello.txt.', '── turn 1', '✓ write_file hello.txt', '1  hello', '2  world', '── turn 2', '[completed]', 'Wrote hello.txt.'];
  const at = order.map(s => done.indexOf(s));
  assert.ok(at.every(i => i >= 0), `missing rows in:\n${done}`);
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  assert.equal(done.split('✓ write_file hello.txt').length - 1, 1);
  const tail = lines(frame()).slice(-2);
  assert.match(tail[0]!, /turn 2 · \d+\/512 req · you$/);
  assert.match(tail[1]!, /^›/);
  assert.equal(frame().includes('__jev_pending__'), false);
});

test('during generation the live pane shows the pending marker and the strip with slot, production, confidence and requests', async t => {
  const { session, wait, frame } = await setup(t, new ScriptedProvider([]));
  for (const e of generating()) session.onEvent(e);
  await wait(/__jev_pending__/);
  const plain = frame();
  assert.match(plain, /◔ write_file hello\.py · generating/);
  assert.match(plain, /1  x = 1/);
  assert.match(plain, /module_body → expr · 41% · low confidence · 2 req/);
  assert.match(plain, /generating content$/m);
  assert.equal(lines(plain).at(-1)?.startsWith('›'), true);
});

test('a confident pick carries no low-confidence mark', async t => {
  const { session, wait } = await setup(t, new ScriptedProvider([]));
  const events = generating();
  events[5] = ev('decision', { model: 'm', choice: 'expr', confidence: 0.95, options: [{ label: 'expr', probability: 0.9 }, { label: 'assign', probability: 0.1 }], field: 'content', phase: 'ast', slot: 'module_body' });
  for (const e of events) session.onEvent(e);
  const plain = await wait(/module_body → expr · 90%/);
  assert.equal(plain.includes('low confidence'), false);
});

test('at 60 columns the pane is hidden, the strip stays and no line exceeds the width (AE7)', async t => {
  const { session, ui, wait, frame } = await setup(t, new ScriptedProvider([]));
  Object.defineProperty(ui.stdout, 'columns', { get: () => 60 });
  ui.stdout.emit('resize');
  for (const e of generating()) session.onEvent(e);
  const plain = await wait(/generating content/);
  assert.equal(plain.includes('__jev_pending__'), false);
  assert.equal(plain.includes('x = 1'), false);
  assert.match(plain, /module_body → expr · 41% · low confidence · 2 req/);
  const tail = lines(plain).slice(lines(plain).findIndex(line => line.startsWith('◔')));
  assert.ok(tail.length >= 4 && tail.every(line => [...line].length <= 60), plain);
});

test('an update typed mid-run keeps prior rows and adds an update row when applied', async t => {
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'old.txt', content: 'old requirements' } },
    { action: 'write_file', args: { path: 'new.txt', content: 'new requirements' } },
    { action: 'finish', args: { summary: 'Applied the update.' } },
  ]);
  let sent = false;
  let typeUpdate: () => Promise<void> = async () => {};
  const { type, wait, frame, workspace } = await setup(t, provider, { onEvent: async event => { if (event.type === 'text' && event.data.field === 'content' && !sent) { sent = true; await typeUpdate(); } } });
  typeUpdate = () => type('Use new.txt instead.');
  await type('Write old.txt.');
  await wait(/Update queued/);
  const done = await wait(/\[completed\]/);
  assert.match(done, /› Write old\.txt\./);
  assert.match(done, /↳ update · Use new\.txt instead\./);
  assert.ok(done.indexOf('› Write old.txt.') < done.indexOf('↳ update'));
  assert.equal(await readFile(join(workspace, 'new.txt'), 'utf8'), 'new requirements');
  await assert.rejects(readFile(join(workspace, 'old.txt')), { code: 'ENOENT' });
  assert.equal(frame().split('› Write old.txt.').length - 1, 1);
});

test('Ctrl-C cancels a run, then exits at the idle prompt', async t => {
  const { session, ui, type, wait } = await setup(t, stall(new ScriptedProvider([])));
  await type('Do something slow.');
  await wait(/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/);
  ui.stdin.write('\x03');
  await wait(/\[cancelled\]/);
  ui.stdin.write('\x03');
  assert.equal(await session.closed, 130);
});

test('NO_COLOR frames contain no escape codes while colored frames do', async t => {
  const provider = new ScriptedProvider([{ action: 'write_file', args: { path: 'a.txt', content: 'a' } }, { action: 'finish', args: { summary: 'Done.' } }]);
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  t.after(() => { if (prev === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prev; });
  const plainRun = await setup(t, provider);
  await plainRun.type('Write a.txt.');
  await plainRun.wait(/\[completed\]/);
  assert.equal(plainRun.ui.lastFrame()!.includes('\x1b['), false);
  delete process.env.NO_COLOR;
  const colored = await setup(t, new ScriptedProvider([{ action: 'write_file', args: { path: 'a.txt', content: 'a' } }, { action: 'finish', args: { summary: 'Done.' } }]));
  await colored.type('Write a.txt.');
  await colored.wait(/\[completed\]/);
  assert.ok(colored.ui.lastFrame()!.includes('\x1b[32m'));
});

test('!<command> renders a host run card and the next run observes its record', async t => {
  const provider = new ScriptedProvider([{ action: 'blocked', args: { summary: 'Nothing else is required.' } }]);
  const { type, wait } = await setup(t, provider);
  await type('!printf hi');
  const shell = await wait(/✓ bash printf hi · exit 0/);
  assert.match(shell, /│ hi/);
  await type('Explain the previous command.');
  await wait(/\[blocked\]/);
  const state = provider.states[0] as unknown as { observations: Array<{ args: { command: string }; result: { output: string } }> };
  assert.equal(state.observations[0]?.args.command, 'printf hi');
  assert.match(state.observations[0]!.result.output, /hi/);
});

test('session commands answer without a model request and /trace lists decisions', async t => {
  const provider = new ScriptedProvider([{ action: 'write_file', args: { path: 'hello.txt', content: 'hello\n' } }, { action: 'finish', args: { summary: 'Done.' } }]);
  const { type, wait, frame } = await setup(t, provider);
  await type('/help');
  await wait(/\/trace \[n\]/);
  await type('/unknown');
  await wait(/Unknown command \/unknown/);
  await type('Create hello.txt.');
  await wait(/\[completed\]/);
  const requests = provider.states.length;
  await type('/files');
  await wait(/^  hello\.txt$/m);
  await type('/show hello.txt');
  await wait(/╭─ hello\.txt/);
  await type('/trace 2');
  await wait(/trace · 2 decisions/);
  await type('/status');
  await wait(/Permissions: auto/);
  await type('/history');
  await wait(/1\. \[completed\] Create hello\.txt\./);
  assert.equal(provider.states.length, requests);
  assert.equal(frame().includes('/trace 2\n'), false);
});

test('/paste submits one task with exact newlines and Tab completes commands', async t => {
  const provider = new ScriptedProvider([{ action: 'blocked', args: { summary: 'Need more information.' } }]);
  const { ui, type, wait } = await setup(t, provider);
  await type('/paste');
  await wait(/paste›/);
  await type('First line');
  await type('  indented second line');
  await type('/end');
  await wait(/\[blocked\]/);
  assert.equal(provider.states[0]?.task.prompt, 'First line\n  indented second line');
  ui.stdin.write('/hi');
  await new Promise(resolve => setTimeout(resolve, 5));
  ui.stdin.write('\t');
  await wait(/› \/history/);
});

test('interactivity needs a TTY on both stdin and the output stream', () => {
  assert.equal(isInteractiveTTY({ isTTY: true }, { isTTY: true }), true);
  assert.equal(isInteractiveTTY({ isTTY: true }, {}), false);
  assert.equal(isInteractiveTTY({}, { isTTY: true }), false);
});

test('the built CLI prints help without loading ink', async t => {
  await exec('node', [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { cwd: root });
  await readFile(join(root, 'dist/ui/app.js'));
  const dir = await mkdtemp(join(tmpdir(), 'jev-hook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'loaded.log');
  await writeFile(join(dir, 'hook.mjs'), `import { appendFileSync } from 'node:fs';\nexport async function resolve(spec, ctx, next) { const r = await next(spec, ctx); appendFileSync(${JSON.stringify(log)}, r.url + '\\n'); return r; }\n`);
  await writeFile(join(dir, 'register.mjs'), `import { register } from 'node:module';\nregister('./hook.mjs', import.meta.url);\n`);
  const { stdout } = await exec('node', ['--import', join(dir, 'register.mjs'), join(root, 'dist/cli.js'), '--help'], { cwd: root });
  assert.match(stdout, /jev-code \[options\]/);
  const loaded = await readFile(log, 'utf8');
  assert.match(loaded, /dist\/cli\.js/);
  assert.equal(loaded.includes('/node_modules/ink/'), false);
  assert.equal(loaded.includes('/dist/ui/'), false);
});
