import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { compareRecords, formatComparison, loadTask, runEval, runPython, type EvalRecord } from '../src/eval.js';
import check_guessing from '../eval/guessing-game/check.js';
import check_fileio from '../eval/file-io-script/check.js';
import check_multi from '../eval/multi-file-package/check.js';
import { ScriptedProvider } from './helpers.js';

async function workspace(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'jev-eval-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const game = `import random
target = random.randint(1, 100)
while True:
    guess = int(input('Guess: '))
    if guess < target:
        print('Too low')
    elif guess > target:
        print('Too high')
    else:
        print('Correct')
        break
`;

test('guessing-game checker drives a correct program to a pass', async t => {
  const ws = await workspace(t);
  await writeFile(join(ws, 'main.py'), game);
  const res = await check_guessing(ws);
  assert.equal(res.ok, true, res.reason);
});

test('guessing-game checker fails on an unrecognizable feedback line and names it', async t => {
  const ws = await workspace(t);
  await writeFile(join(ws, 'main.py'), game.replace("print('Too low')", "print('warmer')"));
  const res = await check_guessing(ws);
  assert.equal(res.ok, false);
  assert.match(res.reason, /warmer/);
});

test('guessing-game checker fails a program that exits before the correct guess', async t => {
  const ws = await workspace(t);
  await writeFile(join(ws, 'main.py'), "guess = int(input('Guess: '))\nprint('Too low')\n");
  const res = await check_guessing(ws);
  assert.equal(res.ok, false);
  assert.match(res.reason, /exited/i);
});

test('guessing-game checker fails a program that prints Correct without any feedback', async t => {
  const ws = await workspace(t);
  await writeFile(join(ws, 'main.py'), "input()\nprint('Correct')\n");
  const res = await check_guessing(ws);
  assert.equal(res.ok, false);
  assert.match(res.reason, /never produced too high\/too low feedback/);
});

test('guessing-game checker fails when no program exists', async t => {
  const ws = await workspace(t);
  const res = await check_guessing(ws);
  assert.equal(res.ok, false);
  assert.match(res.reason, /no main\.py/);
});

test('file-io checker passes on expected file content and fails when absent or wrong', async t => {
  const ws = await workspace(t);
  await writeFile(join(ws, 'main.py'), `def write_numbers(path):
    f = open(path, 'w')
    for i in range(1, 6):
        f.write(str(i) + '\\n')
    f.close()
def read_sum(path):
    total = 0
    for line in open(path):
        total = total + int(line)
    return total
write_numbers('numbers.txt')
print(read_sum('numbers.txt'))
`);
  assert.equal((await check_fileio(ws)).ok, true);
  await writeFile(join(ws, 'main.py'), "print(15)\n");
  await rm(join(ws, 'numbers.txt'));
  const missing = await check_fileio(ws);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /numbers\.txt/);
  await writeFile(join(ws, 'main.py'), "open('numbers.txt', 'w').write('1\\n2\\n')\nprint(3)\n");
  assert.equal((await check_fileio(ws)).ok, false);
});

test('multi-file checker requires two python files and a runnable main.py', async t => {
  const ws = await workspace(t);
  await writeFile(join(ws, 'main.py'), "print('Hello, World!')\n");
  const single = await check_multi(ws);
  assert.equal(single.ok, false);
  assert.match(single.reason, /two/);
  await writeFile(join(ws, 'unused.py'), 'x = 1\n');
  const unrelated = await check_multi(ws);
  assert.equal(unrelated.ok, false);
  assert.match(unrelated.reason, /does not import a local module/);
  await rm(join(ws, 'unused.py'));
  await mkdir(join(ws, 'greet'));
  await writeFile(join(ws, 'greet', '__init__.py'), '');
  await writeFile(join(ws, 'greet', 'text.py'), "def greeting(name):\n    return 'Hello, ' + name + '!'\n");
  await writeFile(join(ws, 'main.py'), "from greet.text import greeting\nprint(greeting('World'))\n");
  assert.equal((await check_multi(ws)).ok, true);
  await rm(join(ws, 'main.py'));
  const entry = await check_multi(ws);
  assert.equal(entry.ok, false);
  assert.match(entry.reason, /no main\.py/);
});

test('checker-spawned programs never see TYPESAFE_API_KEY', async t => {
  const ws = await workspace(t);
  process.env.TYPESAFE_API_KEY = 'secret-for-test';
  t.after(() => { delete process.env.TYPESAFE_API_KEY; });
  await writeFile(join(ws, 'main.py'), "import os\nprint(os.environ.get('TYPESAFE_API_KEY', 'absent'))\n");
  const res = await runPython(ws, ['main.py'], { timeoutMs: 5000 });
  assert.equal(res.stdout.trim(), 'absent');
});

test('task loader rejects limits that are not positive integers', async t => {
  const dir = await workspace(t);
  await writeFile(join(dir, 'task.json'), JSON.stringify({ prompt: 'x', stage: 'test', limits: { maxTurns: 0 } }));
  await writeFile(join(dir, 'check.ts'), 'export default async () => ({ ok: true, reason: "" });\n');
  await assert.rejects(loadTask(dir), /maxTurns/);
});

test('runner writes a record with all fields for a scripted task', async t => {
  const tasks = await workspace(t);
  const out = await workspace(t);
  await mkdir(join(tasks, 'trivial'));
  await writeFile(join(tasks, 'trivial', 'task.json'), JSON.stringify({ prompt: 'Write "hi" into hi.txt.', stage: 'test', limits: { maxTurns: 5 } }));
  await writeFile(join(tasks, 'trivial', 'check.ts'), `import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export default async (ws: string) => ({ ok: (await readFile(join(ws, 'hi.txt'), 'utf8')) === 'hi', reason: 'hi.txt content' });
`);
  const provider = new ScriptedProvider([{ action: 'write_file', args: { path: 'hi.txt', content: 'hi' } }, { action: 'finish', verdict: 1 }]);
  const records = await runEval({ tasksDir: tasks, out, provider });
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.task, 'trivial');
  assert.equal(r.stage, 'test');
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.check, { ok: true, reason: 'hi.txt content' });
  assert.equal(typeof r.turns, 'number');
  assert.equal(typeof r.requests, 'number');
  assert.equal(typeof r.inputTokens, 'number');
  assert.equal(typeof r.durationMs, 'number');
  assert.match(r.runId, /^[0-9a-f-]{36}$/);
  assert.ok(r.commit === null || /^[0-9a-f]{40}$/.test(r.commit));
  const files = (await readdir(join(out, '.jev', 'eval'))).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1);
  assert.ok((await readdir(join(out, '.jev', 'eval', 'journals', 'trivial'))).length === 1);
  const saved = JSON.parse(await readFile(join(out, '.jev', 'eval', files[0]!), 'utf8')) as unknown[];
  assert.deepEqual(saved, records);
});

test('runner rejects an unknown task name', async t => {
  const tasks = await workspace(t);
  const provider = new ScriptedProvider([]);
  await assert.rejects(runEval({ tasksDir: tasks, out: tasks, provider, only: 'nope' }), /nope/);
});

test('cli eval with an unknown task exits nonzero with a one-line error', async () => {
  const run = promisify(execFile);
  await assert.rejects(run('npx', ['tsx', resolve('src/cli.ts'), 'eval', 'no-such-task'], { cwd: resolve('.'), env: { ...process.env, TYPESAFE_API_KEY: 'x' } }),
    (err: Error & { code?: unknown; stderr?: string }) => err.code === 1 && /no-such-task/.test(err.stderr ?? ''));
});

const record = (task: string, ok: boolean, requests: number, durationMs: number, status = 'completed'): EvalRecord => ({
  task, stage: 'x', status, summary: '', check: { ok, reason: '' }, turns: 1, requests, inputTokens: 1, durationMs, runId: 'r', commit: null, startedAt: 's',
});

test('compare prints one row per task with deltas', () => {
  const rows = compareRecords([record('a', false, 100, 30_000), record('b', true, 20, 5_000)], [record('a', true, 80, 20_000), record('b', true, 25, 6_000)]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]!.deltas, { requests: -20, durationMs: -10_000 });
  const text = formatComparison(rows);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[2]!, /^\| a \| fail → pass \| 100 → 80 \(-20\) \| 30\.0 s → 20\.0 s \(-10\.0 s\) \| completed → completed \|$/);
  assert.match(lines[3]!, /\| b \| pass → pass \| 20 → 25 \(\+5\) \|/);
});

test('compare marks a task missing from one record as absent instead of throwing', () => {
  const rows = compareRecords([record('a', false, 100, 30_000)], [record('a', true, 80, 20_000), record('c', true, 10, 1_000)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.a, undefined);
  assert.equal(rows[1]!.deltas, undefined);
  const text = formatComparison(rows);
  assert.match(text, /\| c \| absent → pass \| absent → 10 \| absent → 1\.0 s \| absent → completed \|/);
});

test('cli eval compare prints the comparison table for two record files', async t => {
  const dir = await workspace(t);
  await writeFile(join(dir, 'a.json'), JSON.stringify([record('a', false, 100, 30_000)]));
  await writeFile(join(dir, 'b.json'), JSON.stringify([record('a', true, 80, 20_000)]));
  const run = promisify(execFile);
  const { stdout } = await run('npx', ['tsx', resolve('src/cli.ts'), 'eval', 'compare', join(dir, 'a.json'), join(dir, 'b.json')], { cwd: resolve('.') });
  assert.match(stdout, /\| a \| fail → pass \| 100 → 80 \(-20\) \|/);
});
