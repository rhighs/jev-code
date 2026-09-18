/** @jsxRuntime automatic @jsxImportSource react */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ScriptedProvider, type Step } from './helpers.js';
import { APPROVAL_DRAFT, APPROVAL_KEYS } from '../src/ui/session.js';
import { lines, setup, tick } from './ui-helpers.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const bash = (command: string): Step => ({ action: 'bash', args: { command, cwd: '.', timeout_ms: '' } });
const two = (): Step[] => [bash('touch a.txt'), bash('touch b.txt'), { action: 'finish', args: { summary: 'Done.' } }];
const prompted = (frames: string[], command: string): boolean => frames.some(f => f.includes(`? bash ${command} · needs approval`));

test('y allows once: the next bash call prompts again and the status line reverts', async t => {
  const { ui, type, wait, frame, press, workspace } = await setup(t, new ScriptedProvider(two()), { yes: false });
  await type('Touch two files.');
  const first = await wait(/\? bash touch a\.txt · needs approval/);
  assert.equal(lines(first).at(-2), APPROVAL_KEYS);
  await press('y');
  await wait(/✓ bash touch a\.txt · exit 0/);
  await wait(/\? bash touch b\.txt · needs approval/);
  await press('y');
  const done = await wait(/\[completed\]/);
  assert.match(lines(done).at(-2)!, /req · you$/);
  assert.equal(done.includes(APPROVAL_KEYS), false);
  assert.equal(done.includes('needs approval'), false);
  assert.equal(prompted(ui.frames, 'touch b.txt'), true);
  await readFile(join(workspace, 'a.txt'));
  await readFile(join(workspace, 'b.txt'));
});

test('a allows the tool for the session: no later bash call prompts (AE3)', async t => {
  const { ui, type, wait, press, workspace } = await setup(t, new ScriptedProvider(two()), { yes: false });
  await type('Touch two files.');
  await wait(/\? bash touch a\.txt · needs approval/);
  await press('a');
  const done = await wait(/\[completed\]/);
  assert.match(done, /✓ bash touch a\.txt · exit 0/);
  assert.match(done, /✓ bash touch b\.txt · exit 0/);
  assert.equal(prompted(ui.frames, 'touch b.txt'), false);
  await readFile(join(workspace, 'b.txt'));
});

test('n records a denied card and the run continues', async t => {
  const provider = new ScriptedProvider([bash('touch denied.txt'), { action: 'blocked', args: { summary: 'Permission was denied.' } }]);
  const { type, wait, press, workspace } = await setup(t, provider, { yes: false });
  await type('Create a file with Bash.');
  await wait(/\? bash touch denied\.txt · needs approval/);
  await press('n');
  const done = await wait(/\[blocked\]/);
  assert.match(done, /⊘ bash touch denied\.txt · denied/);
  assert.match(done, /Host declined/);
  await assert.rejects(readFile(join(workspace, 'denied.txt')), { code: 'ENOENT' });
});

test('keys other than y, n and a are ignored while awaiting, and typing never reaches the input box', async t => {
  const { type, wait, frame, press, ui } = await setup(t, new ScriptedProvider([bash('printf ok'), { action: 'finish', args: { summary: 'Done.' } }]), { yes: false });
  await type('Run printf.');
  await wait(/\? bash printf ok · needs approval/);
  for (const key of ['x', 'q', '\r', 'hello']) await press(key);
  await tick(50);
  const still = frame();
  assert.match(still, /\? bash printf ok · needs approval/);
  assert.equal(lines(still).at(-2), APPROVAL_KEYS);
  assert.equal(lines(still).at(-1)?.includes('hello'), false);
  assert.equal(lines(still).at(-1)?.includes('x'), false);
  await press('y');
  const done = await wait(/\[completed\]/);
  assert.equal(lines(done).at(-1)?.trim(), '›');
  assert.equal(ui.frames.some(f => /›.*(hello|xq)/.test(f)), false);
});

test('permission auto never prompts', async t => {
  const { ui, type, wait } = await setup(t, new ScriptedProvider(two()), { yes: true });
  await type('Touch two files.');
  const done = await wait(/\[completed\]/);
  assert.match(done, /✓ bash touch b\.txt · exit 0/);
  assert.equal(ui.frames.some(f => f.includes('needs approval') || f.includes(APPROVAL_KEYS)), false);
});

test('Ctrl-C while awaiting releases the prompt and the run is cancelled without running the command', async t => {
  const { ui, type, wait, workspace } = await setup(t, new ScriptedProvider([bash('touch cancelled.txt')]), { yes: false });
  await type('Create cancelled.txt with Bash.');
  await wait(/\? bash touch cancelled\.txt · needs approval/);
  ui.stdin.write('\x03');
  await wait(/\[cancelled\]/);
  await assert.rejects(readFile(join(workspace, 'cancelled.txt')), { code: 'ENOENT' });
});

test('the source CLI loads no ink for --help or --print', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-hook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'loaded.log');
  await writeFile(join(dir, 'hook.mjs'), `import { appendFileSync } from 'node:fs';\nexport async function resolve(spec, ctx, next) { const r = await next(spec, ctx); appendFileSync(${JSON.stringify(log)}, r.url + '\\n'); return r; }\n`);
  await writeFile(join(dir, 'register.mjs'), `import { register } from 'node:module';\nregister('./hook.mjs', import.meta.url);\n`);
  const run = (args: string[]) => exec('node', ['--import', join(dir, 'register.mjs'), '--import', 'tsx', join(root, 'src/cli.ts'), ...args],
    { cwd: root, env: { ...process.env, TYPESAFE_API_KEY: 'test', TYPESAFE_BASE_URL: 'http://127.0.0.1:9' } }).catch((err: { stdout: string; stderr: string }) => err);
  const help = await run(['--help']);
  assert.match(help.stdout, /jev-code \[options\]/);
  const print = await run(['--print', '--no-journal', '--workspace', dir, 'say hi']);
  assert.match(print.stdout, /\[error\]/);
  const loaded = await readFile(log, 'utf8');
  assert.match(loaded, /src\/cli\.ts/);
  assert.match(loaded, /src\/print\.ts/);
  assert.equal(loaded.includes('/node_modules/ink/'), false);
  assert.equal(loaded.includes('/node_modules/react/'), false);
  assert.equal(loaded.includes('/src/ui/'), false);
});

test('a multi-line command is listed in full on the awaiting card, and the header names only its first line', async t => {
  const command = `echo ${'a'.repeat(120)}\ntouch multi.txt\necho done`;
  const { type, wait, press } = await setup(t, new ScriptedProvider([bash(command), { action: 'finish', args: { summary: 'Done.' } }]), { yes: false });
  await type('Run the script.');
  const card = await wait(/needs approval/);
  const flat = card.replace(/\n/g, '');
  assert.match(flat, /\? bash echo a+ … · needs approval/);
  assert.match(card, /│ touch multi\.txt/);
  assert.match(card, /│ echo done/);
  assert.match(flat, new RegExp(`│ echo ${'a'.repeat(120)}`));
  await press('y');
  await wait(/\[completed\]/);
});

test('approval keys are ignored during the grace window right after the card appears', async t => {
  const { type, wait, press, frame } = await setup(t, new ScriptedProvider([bash('touch late.txt'), { action: 'finish', args: { summary: 'Done.' } }]), { yes: false, approvalGraceMs: 250 });
  await type('Touch a file.');
  await wait(/\? bash touch late\.txt · needs approval/);
  await press('a');
  await tick(30);
  assert.match(frame(), /needs approval/);
  await tick(300);
  await press('y');
  await wait(/\[completed\]/);
});

test('a half-typed line keeps the approval keys inactive until it is sent or erased', async t => {
  let typed = false;
  const { ui, type, wait, press, frame, workspace } = await setup(t, new ScriptedProvider(two()), { yes: false,
    onEvent: async event => { if (event.type === 'action' && !typed) { typed = true; ui.stdin.write('make '); } } });
  await type('Touch two files.');
  const card = await wait(/\? bash touch a\.txt · needs approval/);
  assert.equal(lines(card).at(-2), APPROVAL_DRAFT);
  await press('a');
  await tick(30);
  assert.match(frame(), /needs approval/);
  assert.match(lines(frame()).at(-1)!, /make a$/);
  ui.stdin.write('\r');
  await wait(/Update queued/);
  assert.equal(lines(frame()).at(-2), APPROVAL_KEYS);
  await press('y');
  await wait(/\? bash touch b\.txt · needs approval/);
  await press('y');
  await wait(/\[completed\]/);
  await readFile(join(workspace, 'b.txt'));
});

test('/permissions ask revokes an earlier a, and /status lists standing grants', async t => {
  const steps = (): Step[] => [bash('touch one.txt'), { action: 'finish', args: { summary: 'Done.' } }];
  const provider = new ScriptedProvider([...steps(), ...steps()]);
  const { ui, type, wait, press } = await setup(t, provider, { yes: false });
  await type('Touch one.');
  await wait(/\? bash touch one\.txt · needs approval/);
  await press('a');
  await wait(/\[completed\]/);
  await type('/status');
  await wait(/Permissions: ask · always: bash/);
  await type('/permissions ask');
  await wait(/Permissions: ask\.\n/);
  await type('Touch one again.');
  await wait(/\? bash touch one\.txt · needs approval/);
  await press('y');
  await wait(/\[completed\][\s\S]*\[completed\]/);
  assert.equal(ui.frames.filter(f => f.includes('needs approval')).length > 0, true);
});
