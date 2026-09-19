import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWrite, builtInTools, runBash, toolContext } from '../src/tools.js';
import { resolveWorkspacePath } from '../src/workspace.js';

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'jev-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  const context = toolContext(root, signal, path => resolveWorkspacePath(root, path));
  const tools = new Map(builtInTools().map(tool => [tool.name, tool]));
  return { root, signal, context, tools };
}

test('file tools handle empty contents, Unicode, nested directories, offsets and atomic permissions', async t => {
  const { root, context, tools } = await setup(t);
  await tools.get('write_file')!.execute({ path: 'nested/a.txt', content: 'hello 🌍\n' }, context);
  assert.equal(await readFile(join(root, 'nested/a.txt'), 'utf8'), 'hello 🌍\n');
  const part = await tools.get('read_file')!.execute({ path: 'nested/a.txt', offset: 0, limit: 5 }, context);
  assert.equal(part.output, 'hello');
  assert.equal(part.data?.nextOffset, 5);
  assert.equal(part.data?.truncated, true);
  await chmod(join(root, 'nested/a.txt'), 0o755);
  await tools.get('write_file')!.execute({ path: 'nested/a.txt', content: '' }, context);
  assert.equal((await stat(join(root, 'nested/a.txt'))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(root, 'nested/a.txt'), 'utf8'), '');
  assert.deepEqual(await readdir(join(root, 'nested')), ['a.txt']);
});

test('ambiguous and missing edits leave original files intact', async t => {
  const { root, context, tools } = await setup(t);
  await writeFile(join(root, 'a.txt'), 'foo foo');
  for (const old_text of ['foo', 'missing', '']) {
    await assert.rejects(tools.get('edit_file')!.execute({ path: 'a.txt', old_text, new_text: 'bar' }, context), /exactly once/);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'foo foo');
  }
});

test('workspace path policy rejects traversal, symlink escapes and dangling symlinks', async t => {
  const { root } = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), 'jev-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'escape'));
  await symlink(join(outside, 'nonexistent'), join(root, 'dangling'));
  await assert.rejects(resolveWorkspacePath(root, '../outside.txt'), /escapes workspace/);
  await assert.rejects(resolveWorkspacePath(root, 'escape/new/file.txt'), /escapes workspace/);
  await assert.rejects(resolveWorkspacePath(root, 'dangling'));
  assert.equal(await resolveWorkspacePath(root, 'escape/new/file.txt', true), join(await realpath(outside), 'new/file.txt'));
  await mkdir(join(root, 'real'));
  await symlink(join(root, 'real'), join(root, 'inside'));
  assert.equal(await resolveWorkspacePath(root, 'inside/a.txt'), join(await realpath(root), 'real/a.txt'));
});

test('cancelled atomic writes preserve existing contents and leave no temp file', async t => {
  const { root } = await setup(t);
  const path = join(root, 'a.txt');
  await writeFile(path, 'original');
  await assert.rejects(atomicWrite(path, 'replacement', AbortSignal.abort(new Error('stop'))));
  assert.equal(await readFile(path, 'utf8'), 'original');
  assert.deepEqual(await readdir(root), ['a.txt']);
});

test('atomic writes preserve existing group permissions and honor umask for new files', async t => {
  const { root, signal } = await setup(t);
  const existing = join(root, 'existing.txt');
  await writeFile(existing, 'old');
  await chmod(existing, 0o664);
  const previous = process.umask(0o077);
  try {
    await atomicWrite(existing, 'new', signal);
    await atomicWrite(join(root, 'new.txt'), 'new', signal);
  } finally { process.umask(previous); }
  assert.equal((await stat(existing)).mode & 0o777, 0o664);
  assert.equal((await stat(join(root, 'new.txt'))).mode & 0o777, 0o600);
});

test('Bash executes pipelines, records stderr and nonzero exits, and bounds output', async t => {
  const { root, signal } = await setup(t);
  const pipeline = await runBash('printf "alpha\\nbeta\\n" | wc -l', root, 1000, signal);
  assert.equal(pipeline.ok, true);
  assert.equal(pipeline.output.trim(), '2');
  const failure = await runBash('printf "broken" >&2; exit 7', root, 1000, signal);
  assert.equal(failure.ok, false);
  assert.equal(failure.data?.exitCode, 7);
  assert.match(failure.output, /broken/);
  const flood = await runBash('node -e "process.stdout.write(\'x\'.repeat(100000))"', root, 3000, signal, 100);
  assert.equal(flood.data?.truncated, true);
  assert.equal(flood.data?.stdoutBytes, 100000);
  assert.ok(flood.output.length < 200);
});

test('Bash timeout kills the process group, including TERM-resistant children', async t => {
  const { root, signal } = await setup(t);
  const start = Date.now();
  const result = await runBash("trap '' TERM; sleep 30", root, 30, signal);
  assert.equal(result.ok, false);
  assert.equal(result.data?.timedOut, true);
  assert.ok(Date.now() - start < 2500);
});

test('Bash cancellation returns a cancelled result promptly', async t => {
  const { root } = await setup(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const result = await runBash('sleep 30', root, 10_000, controller.signal);
  assert.equal(result.ok, false);
  assert.equal(result.data?.cancelled, true);
});

test('the bash tool never exposes JEV_GENERATION_API_KEY to the child', async t => {
  const { context, tools } = await setup(t);
  const prev = process.env.JEV_GENERATION_API_KEY;
  process.env.JEV_GENERATION_API_KEY = 'sk-x';
  t.after(() => { if (prev === undefined) delete process.env.JEV_GENERATION_API_KEY; else process.env.JEV_GENERATION_API_KEY = prev; });
  const result = await tools.get('bash')!.execute({ command: 'printf %s "${JEV_GENERATION_API_KEY:-absent}"', cwd: '.' }, context);
  assert.equal(result.ok, true);
  assert.equal(result.output, 'absent');
});

test('Bash streaming callback errors fail the command and release its resources', async t => {
  const { root, signal } = await setup(t);
  await assert.rejects(runBash('printf "output\\n"; sleep 30', root, 1000, signal, 100,
    async () => { throw new Error('Output consumer failed.'); }), /Output consumer failed/);
});

test('process-group permission errors return a failed result instead of crashing cleanup', async t => {
  if (process.platform === 'win32') return;
  const { root, signal } = await setup(t);
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, sig?: string | number) => {
    if (pid < 0) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return kill(pid, sig);
  });
  const result = await runBash('exec sleep 30', root, 40, signal);
  assert.equal(result.ok, false);
  assert.match(result.output, /Could not terminate the command group: EPERM/);
  assert.equal(result.data?.timedOut, true);
});
