/** @jsxRuntime automatic @jsxImportSource react */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify, stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import { Harness } from '../src/harness.js';
import { printRun } from '../src/print.js';
import { checkSchema, findJournal, findLatestJournal, gapMs, MAX_GAP_MS, prepareResume, readJournal, replayPlain } from '../src/replay.js';
import { attemptScope } from '../src/run-context.js';
import { initialState, reduce } from '../src/transcript.js';
import type { HarnessEvent, HarnessEventData, ToolRecord } from '../src/types.js';
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

const journalEvent = <K extends keyof HarnessEventData>(runId: string, type: K, data: HarnessEventData[K], turn = 1): HarnessEvent =>
  ({ type, runId, timestamp: '2026-10-10T00:00:00.000Z', elapsedMs: turn * 10, turn, data }) as HarnessEvent;
const journalStart = (runId: string, workspace: string, prompt = PROMPT, resume?: { from: string; turns: number; requests: number }): HarnessEvent =>
  journalEvent(runId, 'start', { schema: 1, prompt, workspace, decoder: 'dynamic', limits: { turns: 50, requests: 512 }, journal: null, ...(resume === undefined ? {} : { resume }) }, 0);
const turnOf = (runId: string, turn: number, plan = ''): HarnessEvent => journalEvent(runId, 'turn', { files: 0, plan }, turn);
const turnEndOf = (runId: string, turn: number, requests: number): HarnessEvent => journalEvent(runId, 'turn_end', { durationMs: 5, elapsedMs: turn * 10, requests }, turn);
const toolStartOf = (runId: string, turn: number, tool: string, args: ToolRecord['args']): HarnessEvent => journalEvent(runId, 'tool_start', { tool, args }, turn);
const toolEndOf = (runId: string, turn: number, tool: string, args: ToolRecord['args'], ok = true, output = 'ok'): HarnessEvent =>
  journalEvent(runId, 'tool_end', { turn, tool, args, result: { ok, output } }, turn);
const endOf = (runId: string, status: HarnessEventData['end']['status'], turn: number, requests = 1): HarnessEvent =>
  journalEvent(runId, 'end', { status, summary: 's', modelSummary: null, turns: turn, requests, usage: { inputTokens: 1, outputTokens: 1 }, startedAt: 'a', endedAt: 'b', durationMs: 10 }, turn);

const writeJournal = async (path: string, events: HarnessEvent[]): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jsonl(events));
};

test('resume reading tolerates a torn final line and truncates at the last complete turn_end', async t => {
  const ws = await tmp(t);
  const path = join(ws, '.jev', 'runs', 'interrupted.jsonl');
  const events = [
    journalStart('interrupted', ws),
    turnOf('interrupted', 1), toolStartOf('interrupted', 1, 'write_file', { path: 'a.txt', content: 'a' }),
    toolEndOf('interrupted', 1, 'write_file', { path: 'a.txt', content: 'a' }), turnEndOf('interrupted', 1, 3),
    turnOf('interrupted', 2), toolStartOf('interrupted', 2, 'bash', { command: 'sleep 60' }), endOf('interrupted', 'cancelled', 2),
  ];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, events.map(event => JSON.stringify(event)).join('\n') + '\n' + '{"type":"turn","data":{"files":0,"plan":"tor');
  const plan = await prepareResume({ journalPath: path, workspace: ws, effectOf: () => 'read' });
  assert.equal(plan.turn, 2, 'the incomplete turn 2 is dropped');
  assert.equal(plan.turns, 1);
  assert.equal(plan.requests, 3, 'carried requests come from turn_end deltas');
  assert.deepEqual(plan.records.map(record => [record.turn, record.tool]), [[1, 'write_file']]);
  assert.ok(plan.warnings.some(warning => /final line was incomplete/.test(warning)), JSON.stringify(plan.warnings));
  assert.ok(plan.warnings.some(warning => /ignored 3 journal events after the last complete turn_end/.test(warning)), JSON.stringify(plan.warnings));
});

test('resume refuses an unmatched shell start and records unknown outcomes for read/write starts', async t => {
  const ws = await tmp(t);
  const runs = join(ws, '.jev', 'runs');
  const effects = (tool: string): 'read' | 'write' | 'shell' | undefined =>
    tool === 'bash' ? 'shell' : tool === 'write_file' ? 'write' : tool === 'read_file' ? 'read' : undefined;

  const bashPath = join(runs, 'bash-run.jsonl');
  await writeJournal(bashPath, [journalStart('bash-run', ws), turnOf('bash-run', 1), toolStartOf('bash-run', 1, 'bash', { command: 'rm -rf build' }),
    turnEndOf('bash-run', 1, 1), endOf('bash-run', 'cancelled', 1)]);
  await assert.rejects(prepareResume({ journalPath: bashPath, workspace: ws, effectOf: effects }), /bash.*effect cannot be verified/);

  const readPath = join(runs, 'read-run.jsonl');
  await writeJournal(readPath, [journalStart('read-run', ws), turnOf('read-run', 1), toolStartOf('read-run', 1, 'read_file', { path: 'a.txt' }),
    turnEndOf('read-run', 1, 1), endOf('read-run', 'cancelled', 1)]);
  const readPlan = await prepareResume({ journalPath: readPath, workspace: ws, effectOf: effects });
  assert.equal(readPlan.records.length, 1);
  assert.equal(readPlan.records[0]!.tool, 'read_file');
  assert.equal(readPlan.records[0]!.result.ok, false);
  assert.match(readPlan.records[0]!.result.output, /Unknown outcome/);
  assert.ok(readPlan.warnings.some(warning => /read_file call at turn 1 has no journaled result/.test(warning)), JSON.stringify(readPlan.warnings));

  const writePath = join(runs, 'write-run.jsonl');
  await writeJournal(writePath, [journalStart('write-run', ws), turnOf('write-run', 1), toolStartOf('write-run', 1, 'write_file', { path: 'a.txt', content: 'a' }),
    turnEndOf('write-run', 1, 1), endOf('write-run', 'cancelled', 1)]);
  const writePlan = await prepareResume({ journalPath: writePath, workspace: ws, effectOf: effects });
  assert.deepEqual(writePlan.records.map(record => [record.tool, record.result.ok]), [['write_file', false]]);
});

test('resume eligibility: blocked is resumable while completed, mismatched, and eval journals are refused', async t => {
  const ws = await tmp(t);
  const runs = join(ws, '.jev', 'runs');
  const effects = (): 'read' => 'read';

  const blockedPath = join(runs, 'blocked.jsonl');
  await writeJournal(blockedPath, [journalStart('blocked', ws), turnOf('blocked', 1), turnEndOf('blocked', 1, 2), endOf('blocked', 'blocked', 1)]);
  const plan = await prepareResume({ journalPath: blockedPath, workspace: ws, effectOf: effects });
  assert.equal(plan.from, 'blocked');
  assert.equal(plan.turn, 2);
  assert.equal(plan.prompt, PROMPT);

  const donePath = join(runs, 'done.jsonl');
  await writeJournal(donePath, [journalStart('done', ws), turnOf('done', 1), turnEndOf('done', 1, 1), endOf('done', 'completed', 1)]);
  await assert.rejects(prepareResume({ journalPath: donePath, workspace: ws, effectOf: effects }), /already completed/);

  const other = await tmp(t, 'jev-replay-other-');
  const otherPath = join(runs, 'other.jsonl');
  await writeJournal(otherPath, [journalStart('other', other), turnOf('other', 1), turnEndOf('other', 1, 1), endOf('other', 'cancelled', 1)]);
  await assert.rejects(prepareResume({ journalPath: otherPath, workspace: ws, effectOf: effects }), /belongs to workspace/);

  const evalPath = join(ws, '.jev', 'eval', 'journals', 'hello', 'eval-run.jsonl');
  await writeJournal(evalPath, [journalStart('eval-run', ws), turnOf('eval-run', 1), turnEndOf('eval-run', 1, 1), endOf('eval-run', 'limited', 1)]);
  await assert.rejects(prepareResume({ journalPath: evalPath, workspace: ws, effectOf: effects }), /eval journal/);

  const futurePath = join(runs, 'future.jsonl');
  const futureStart = { ...journalStart('future', ws), data: { ...journalStart('future', ws).data, schema: 2 } } as unknown as HarnessEvent;
  await writeJournal(futurePath, [futureStart, turnOf('future', 1), turnEndOf('future', 1, 1), endOf('future', 'limited', 1)]);
  await assert.rejects(prepareResume({ journalPath: futurePath, workspace: ws, effectOf: effects }), /schema 2.*supported schema 1/);
});

test('resume rebuilds decision ids and alternatives best-effort from journaled options', async t => {
  const ws = await tmp(t);
  const path = join(ws, '.jev', 'runs', 'decision-run.jsonl');
  const decision = journalEvent('decision-run', 'decision', { model: 'm', choice: 'value_0', confidence: 0.6,
    options: [{ label: 'value_0', probability: 0.6 }, { label: 'value_1', probability: 0.4 }],
    decisionId: 4, nearTie: true, field: 'content', phase: 'ast', slot: 'string', unit: 'greet' }, 1);
  await writeJournal(path, [journalStart('decision-run', ws), turnOf('decision-run', 1), decision, turnEndOf('decision-run', 1, 1), endOf('decision-run', 'cancelled', 1)]);
  const plan = await prepareResume({ journalPath: path, workspace: ws, effectOf: () => 'read' });
  assert.deepEqual(plan.decisions, [{
    decisionId: 4, scope: attemptScope('content', 'greet'), questionKey: 'string',
    identity: { field: 'content', phase: 'ast', slot: 'string', unit: 'greet' },
    chosen: 'value_0', alternatives: [{ label: 'value_0', probability: 0.6 }, { label: 'value_1', probability: 0.4 }], nearTie: true,
  }]);
});

test('a chained resume keeps the usage carried by the journal it continues', async t => {
  const ws = await tmp(t);
  const path = join(ws, '.jev', 'runs', 'second.jsonl');
  await writeJournal(path, [
    journalStart('second', ws, PROMPT, { from: 'first', turns: 10, requests: 100 }),
    turnOf('second', 11), turnEndOf('second', 11, 5), endOf('second', 'cancelled', 11),
  ]);
  const plan = await prepareResume({ journalPath: path, workspace: ws, effectOf: () => 'read' });
  assert.equal(plan.requests, 105, 'the earlier carried usage survives a chained resume');
  assert.equal(plan.turn, 12);
  assert.equal(plan.turns, 11);
});

test('findLatestJournal picks the newest journal by mtime', async t => {
  const ws = await tmp(t);
  const runs = join(ws, '.jev', 'runs');
  await mkdir(runs, { recursive: true });
  const older = join(runs, 'older.jsonl'), newer = join(runs, 'newer.jsonl');
  await writeFile(older, jsonl([journalStart('older', ws)]));
  await writeFile(newer, jsonl([journalStart('newer', ws)]));
  await utimes(older, new Date(1_000), new Date(1_000));
  await utimes(newer, new Date(2_000), new Date(2_000));
  assert.equal(await findLatestJournal(ws), newer);
  await rm(newer);
  assert.equal(await findLatestJournal(ws), older);
});

test('replaying a resumed journal renders the continuation marker and seeds the request counter', async () => {
  const events: HarnessEvent[] = [
    journalStart('next', '/ws', PROMPT, { from: 'abc', turns: 4, requests: 9 }),
    journalEvent('next', 'decision', { model: 'm', choice: 'write_file', confidence: 1, options: [{ label: 'write_file', probability: 1 }] }, 5),
    turnEndOf('next', 5, 1),
    journalEvent('next', 'end', { status: 'completed', summary: 'Done.', modelSummary: null, turns: 5, requests: 10, usage: { inputTokens: 1, outputTokens: 1 }, startedAt: 'a', endedAt: 'b', durationMs: 100 }, 5),
  ];
  const state = events.reduce(reduce, initialState());
  assert.deepEqual(state.items.map(item => item.kind), ['prompt', 'resume', 'summary']);
  assert.equal(state.requests, 10, 'the counter seeds from the resume field and adds new decisions');

  const out = capture();
  await replayPlain(events, out);
  assert.match(out.text().err, /⤵ resume · resumed from abc at turn 5 with 9 requests carried/);
  assert.match(out.text().err, /› Write hello into hello.txt and print it\./);
  assert.match(out.text().out, /5\/50 turns/);
  assert.match(out.text().out, /10\/512 requests/);
});

test('cli --resume refuses missing, completed, mismatched, and eval journals before asking for a key', async t => {
  const cwd = await tmp(t);
  const runs = join(cwd, '.jev', 'runs');
  await mkdir(runs, { recursive: true });
  await writeFile(join(runs, 'done.jsonl'), jsonl([journalStart('done', cwd), turnOf('done', 1), turnEndOf('done', 1, 1), endOf('done', 'completed', 1)]));
  await writeFile(join(runs, 'blocked.jsonl'), jsonl([journalStart('blocked', cwd), turnOf('blocked', 1), turnEndOf('blocked', 1, 1), endOf('blocked', 'blocked', 1)]));
  const other = await tmp(t, 'jev-replay-other-');
  await writeFile(join(runs, 'other.jsonl'), jsonl([journalStart('other', other), turnOf('other', 1), turnEndOf('other', 1, 1), endOf('other', 'cancelled', 1)]));
  await writeJournal(join(cwd, '.jev', 'eval', 'journals', 'hello', 'eval-run.jsonl'),
    [journalStart('eval-run', cwd), turnOf('eval-run', 1), turnEndOf('eval-run', 1, 1), endOf('eval-run', 'limited', 1)]);

  const cli = resolve('src/cli.ts');
  // An isolated (missing) config dir plus an empty key variable keeps the key check deterministic:
  // no saved key and no prompt in a non-TTY.
  const env = { ...process.env, NO_COLOR: '1', TYPESAFE_API_KEY: '', JEV_CODE_CONFIG_DIR: join(cwd, 'no-config') };
  const refusal = async (args: string[], pattern: RegExp): Promise<void> => {
    await assert.rejects(exec(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], { cwd, env, timeout: 60_000 }),
      (err: Error & { code: number; stderr: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, pattern);
        return true;
      });
  };
  await refusal(['--resume', 'nope'], /No journal found for run nope/);
  await refusal(['--resume', 'done'], /already completed/);
  await refusal(['--resume', 'other'], /belongs to workspace/);
  await refusal(['--resume', 'eval-run'], /eval journal/);
  await refusal(['--resume', 'blocked', 'extra task'], /without a positional task/);
  await refusal(['--resume', 'blocked', '--no-journal'], /requires journaling/);
  await refusal(['--resume', 'blocked', '--interactive'], /cannot be combined with --interactive/);
  await refusal(['--resume', 'blocked'], /No API key/);
});

test('cli --resume last resolves the newest journal and refuses an older completed one', async t => {
  const cwd = await tmp(t);
  const runs = join(cwd, '.jev', 'runs');
  await mkdir(runs, { recursive: true });
  await writeFile(join(runs, 'done.jsonl'), jsonl([journalStart('done', cwd), turnOf('done', 1), turnEndOf('done', 1, 1), endOf('done', 'completed', 1)]));
  await writeFile(join(runs, 'blocked.jsonl'), jsonl([journalStart('blocked', cwd), turnOf('blocked', 1), turnEndOf('blocked', 1, 1), endOf('blocked', 'blocked', 1)]));
  await utimes(join(runs, 'done.jsonl'), new Date(1_000), new Date(1_000));
  await utimes(join(runs, 'blocked.jsonl'), new Date(2_000), new Date(2_000));

  const cli = resolve('src/cli.ts');
  const env = { ...process.env, NO_COLOR: '1', TYPESAFE_API_KEY: '', JEV_CODE_CONFIG_DIR: join(cwd, 'no-config') };
  await assert.rejects(exec(process.execPath, ['--import', import.meta.resolve('tsx'), cli, '--resume', 'last'], { cwd, env, timeout: 60_000 }),
    (err: Error & { code: number; stderr: string }) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /No API key/, 'last resolved the resumable journal rather than the completed one');
      return true;
    });
});
