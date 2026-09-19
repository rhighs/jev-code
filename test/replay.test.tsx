/** @jsxRuntime automatic @jsxImportSource react */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify, stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import { Harness } from '../src/harness.js';
import { printRun } from '../src/print.js';
import { checkSchema, findJournal, gapMs, MAX_GAP_MS, readJournal, replayPlain } from '../src/replay.js';
import type { HarnessEvent } from '../src/types.js';
import { App } from '../src/ui/app.js';
import { createReplaySession, replayFooter } from '../src/ui/replay-session.js';
import { ScriptedProvider } from './helpers.js';
import { tick } from './ui-helpers.js';

const exec = promisify(execFile);
const PROMPT = 'Write hello into hello.txt and print it.';
const script = (): ScriptedProvider => new ScriptedProvider([
  { action: 'write_file', args: { path: 'hello.txt', content: 'hello\n' } },
  { action: 'bash', args: { command: 'cat hello.txt', cwd: '.', timeout_ms: '' } },
  { action: 'finish', verdict: 1 },
]);

const tmp = async (t: test.TestContext, prefix = 'jev-replay-'): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
};

const capture = (): { stdout: PassThrough; stderr: PassThrough; text: () => { out: string; err: string } } => {
  const stdout = new PassThrough(), stderr = new PassThrough();
  let out = '', err = '';
  stdout.on('data', d => { out += String(d); });
  stderr.on('data', d => { err += String(d); });
  return { stdout, stderr, text: () => ({ out, err }) };
};

const events = async (t: test.TestContext): Promise<HarnessEvent[]> => {
  const ws = await tmp(t);
  const all: HarnessEvent[] = [];
  const result = await new Harness({ workspace: ws, provider: script(), experimentalGrid: true, journalDirectory: false, onEvent: e => { all.push(e); } }).run(PROMPT);
  assert.equal(result.status, 'completed', result.summary);
  return all;
};

const jsonl = (all: unknown[]): string => all.map(e => JSON.stringify(e)).join('\n') + '\n';
const withSchema = (all: HarnessEvent[], schema: number | undefined): unknown[] => all.map((e, i) => {
  if (i !== 0) return e;
  const { schema: _s, ...data } = e.data as Record<string, unknown>;
  return { ...e, data: schema === undefined ? data : { schema, ...data } };
});

test('a journal from a scripted run replays plain to the same lines as the original --print output', async t => {
  const ws = await tmp(t);
  const dir = join(ws, '.jev', 'runs');
  const live = capture();
  const result = await printRun({ harness: { workspace: ws, provider: script(), experimentalGrid: true, journalDirectory: dir }, prompt: PROMPT,
    stdin: new PassThrough(), stdout: live.stdout, stderr: live.stderr, yes: true, confirmWrites: false, json: false, signal: new AbortController().signal });
  assert.equal(result.status, 'completed', result.summary);
  const path = await findJournal(ws, result.id);
  assert.equal(path, join(dir, `${result.id}.jsonl`));
  const all = await readJournal(path!);
  assert.equal(checkSchema(all), undefined);
  const again = capture();
  await replayPlain(all, again);
  assert.equal(again.text().err, live.text().err);
  assert.equal(again.text().out, live.text().out);
  assert.match(again.text().err, /✓ write_file hello.txt/);
  assert.match(again.text().out, /\[completed\]/);
});

test('an eval journal path resolves, and a full .jsonl path is accepted as is', async t => {
  const ws = await tmp(t);
  const dir = join(ws, '.jev', 'eval', 'journals', 'hello');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'abc.jsonl'), '');
  assert.equal(await findJournal(ws, 'abc'), join(dir, 'abc.jsonl'));
  assert.equal(await findJournal(ws, join(dir, 'abc.jsonl')), join(dir, 'abc.jsonl'));
  assert.equal(await findJournal(ws, 'missing'), undefined);
});

test('a journal without schema replays with a warning; schema 2 is refused naming both versions', async t => {
  const all = await events(t);
  const legacy = withSchema(all, undefined) as HarnessEvent[];
  const warning = checkSchema(legacy);
  assert.match(warning ?? '', /schema/);
  const out = capture();
  await replayPlain(legacy, out);
  assert.match(out.text().err, /✓ write_file hello.txt/);
  assert.match(out.text().out, /\[completed\]/);
  assert.throws(() => checkSchema(withSchema(all, 2) as HarnessEvent[]), /2.*1|1.*2/);
  assert.throws(() => checkSchema(all.slice(1)), /start/);
});

test('pacing divides elapsed gaps by the speed and caps any single gap at two seconds', () => {
  const at = (elapsedMs: number): HarnessEvent => ({ type: 'turn', runId: 'r', timestamp: 't', elapsedMs, turn: 1, data: { files: 0, plan: '' } });
  assert.equal(gapMs(at(0), at(500), 1), 500);
  assert.equal(gapMs(at(0), at(500), 2), 250);
  assert.equal(gapMs(at(0), at(5000), 1), MAX_GAP_MS);
  assert.equal(gapMs(at(0), at(5000), 0), 0);
  assert.equal(gapMs(at(500), at(0), 1), 0);
});

test('a paced replay stops as soon as its signal aborts', async t => {
  const all = (await events(t)).map((e, i) => ({ ...e, elapsedMs: i * 5000 }));
  const controller = new AbortController();
  const out = capture();
  const started = performance.now();
  setTimeout(() => controller.abort(), 50);
  await replayPlain(all, out, 1, controller.signal);
  assert.ok(performance.now() - started < 1000);
  assert.equal(out.text().out, '');
});

test('Ink replay shows the cards and the replay footer, and Ctrl-C exits at once', async t => {
  const all = await events(t);
  const session = createReplaySession(false);
  const ui = render(<App session={session} footer={replayFooter('run-1', 0)} />);
  t.after(() => { session.close(0); ui.unmount(); });
  for (const e of all) session.onEvent(e);
  await tick(20);
  const frame = stripVTControlCharacters(ui.lastFrame() ?? '');
  for (const s of ['› Write hello into hello.txt', '✓ write_file hello.txt', '✓ bash cat hello.txt', '[completed]', 'replay · run-1 · speed instant · Ctrl-C to exit']) assert.ok(frame.includes(s), `missing ${s} in:\n${frame}`);
  assert.equal(frame.trimEnd().split('\n').at(-1), 'replay · run-1 · speed instant · Ctrl-C to exit');
  const paced = createReplaySession(false);
  const ui2 = render(<App session={paced} footer={replayFooter('run-2', 1)} />);
  t.after(() => ui2.unmount());
  paced.onEvent(all[0]!);
  await tick(10);
  ui2.stdin.write('\x03');
  const code = await Promise.race([paced.closed, new Promise<string>(r => setTimeout(() => r('timeout'), 1000))]);
  assert.equal(code, 0);
});

test('cli replay --plain renders a journal in a temp workspace, and rejects unknown ids and newer schemas', async t => {
  const all = await events(t);
  const cwd = await tmp(t);
  const env = { ...process.env, NO_COLOR: '1' };
  await mkdir(join(cwd, '.jev', 'runs'), { recursive: true });
  await writeFile(join(cwd, '.jev', 'runs', 'good.jsonl'), jsonl(all));
  await writeFile(join(cwd, '.jev', 'runs', 'future.jsonl'), jsonl(withSchema(all, 2)));
  const cli = resolve('src/cli.ts');
  const ok = await exec(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'replay', 'good', '--plain'], { cwd, env, timeout: 60_000 });
  assert.match(ok.stderr, /✓ write_file hello.txt/);
  assert.match(ok.stdout, /\[completed\]/);
  await assert.rejects(exec(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'replay', 'nope', '--plain'], { cwd, env, timeout: 60_000 }), (err: Error & { code: number; stderr: string }) => {
    assert.equal(err.code, 1);
    assert.equal(err.stderr.trim().split('\n').length, 1, err.stderr);
    assert.match(err.stderr, /nope/);
    return true;
  });
  await assert.rejects(exec(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'replay', 'future', '--plain'], { cwd, env, timeout: 60_000 }), (err: Error & { code: number; stderr: string }) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /2/);
    assert.match(err.stderr, /1/);
    return true;
  });
});
