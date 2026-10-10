import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PythonWorker, type PythonWorkerSpawn } from '../src/python-worker.js';
import { createRunContext } from '../src/run-context.js';

const signal = new AbortController().signal;
const call = { signal };
const tree = { _type: 'Module', body: [], type_ignores: [] };

/** Spawn-count probe: wraps the real spawner and records every child it returns. */
function probe(): { spawner: PythonWorkerSpawn; children: ChildProcess[] } {
  const children: ChildProcess[] = [];
  const spawner: PythonWorkerSpawn = (command, args, options) => {
    const child = spawn(command, args, options);
    children.push(child);
    return child;
  };
  return { spawner, children };
}

test('one lazy worker serves all four bridge operations through one child', async () => {
  const { spawner, children } = probe();
  const worker = new PythonWorker({ spawn: spawner });
  assert.equal(await worker.run('unparse', tree, call), '');
  await worker.run('source', 'value = 1\n', call);
  const root = await mkdtemp(join(tmpdir(), 'jev-worker-'));
  try {
    await writeFile(join(root, 'main.py'), 'import os\nfrom os import path\n', 'utf8');
    await worker.run('project', { root, paths: ['main.py'] }, call);
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.deepEqual(await worker.run('candidate', { source: 'def f(x):\n    return y\n', name: 'f', params: ['x'], peers: {}, wantsReturn: true }, call),
    { reason: 'undefined', symbol: 'y' });
  assert.equal(children.length, 1, 'all four operations reuse one child');
  assert.equal(worker.spawnCount, 1);
  worker.dispose();
  assert.ok(children[0]!.killed, 'disposal kills the child');
});

test('fifty sequential renders reuse one child', async () => {
  const { spawner, children } = probe();
  const worker = new PythonWorker({ spawn: spawner });
  for (let index = 0; index < 50; index++) assert.equal(await worker.run('unparse', tree, call), '');
  assert.equal(children.length, 1);
  assert.equal(worker.spawnCount, 1);
  worker.dispose();
});

test('cancelling one request rejects only it and leaves a concurrent sibling in flight', async () => {
  const { spawner, children } = probe();
  const worker = new PythonWorker({ spawn: spawner });
  await worker.run('unparse', tree, call); // warm up so both requests share a live child
  const controller = new AbortController();
  const cancelled = worker.run('unparse', tree, { signal: controller.signal });
  const sibling = worker.run('unparse', tree, call);
  controller.abort(new Error('Cancelled'));
  await assert.rejects(cancelled, /Cancelled/);
  assert.equal(await sibling, '', 'the sibling request is unaffected by the cancellation');
  assert.equal(children.length, 1, 'the worker survives a cancelled request');
  assert.equal(worker.alive, true);
  worker.dispose();
});

test('an already-aborted request never spawns a child', async () => {
  const { spawner, children } = probe();
  const worker = new PythonWorker({ spawn: spawner });
  await assert.rejects(worker.run('unparse', tree, { signal: AbortSignal.abort(new Error('Cancelled')) }), /Cancelled/);
  assert.equal(children.length, 0);
  worker.dispose();
});

test('a timed-out request rejects every in-flight call and the next call restarts the worker', async () => {
  const { spawner, children } = probe();
  const worker = new PythonWorker({ spawn: spawner, timeoutMs: 1 });
  const first = worker.run('unparse', tree, call);
  const second = worker.run('unparse', tree, call);
  await assert.rejects(first, /timed out after 1ms; every in-flight call was rejected/);
  await assert.rejects(second, /timed out after 1ms; every in-flight call was rejected/);
  assert.equal(worker.alive, false);
  assert.equal(await worker.run('unparse', tree, { signal, timeoutMs: 10_000 }), '', 'the worker restarted');
  assert.equal(children.length, 2);
  worker.dispose();
});

test('a crashed child rejects every in-flight call deterministically and the next call restarts it', async () => {
  const { spawner, children } = probe();
  const worker = new PythonWorker({ spawn: spawner });
  await worker.run('unparse', tree, call); // warm up
  const big = Array.from({ length: 20_000 }, (_, index) => `value_${index} = ${index}`).join('\n');
  const first = worker.run('source', big, call);
  const second = worker.run('source', big, call);
  children[0]!.kill('SIGKILL');
  const outcomes = await Promise.allSettled([first, second]);
  const messages = outcomes.map(outcome => outcome.status === 'rejected' ? String((outcome.reason as Error).message) : `resolved: ${String(outcome.value)}`);
  assert.match(messages[0]!, /worker exited|worker stdin failed/);
  assert.equal(messages[1], messages[0], 'every in-flight call rejects with the same deterministic error');
  assert.equal(worker.alive, false);
  assert.equal(await worker.run('unparse', tree, call), '', 'the worker restarted on the next call');
  assert.equal(children.length, 2);
  worker.dispose();
});

test('a missing python3 falls back to spawn-per-call', async () => {
  let spawns = 0;
  const spawner: PythonWorkerSpawn = (command, args, options) => {
    spawns++;
    return spawn('python3-does-not-exist-jev', args, options);
  };
  const worker = new PythonWorker({ spawn: spawner });
  await assert.rejects(worker.run('unparse', tree, call), /ENOENT/);
  assert.equal(worker.usingFallback, true, 'a missing python3 switches to the spawn-per-call fallback');
  assert.equal(spawns, 2, 'the failed worker attempt then one spawn-per-call child');
  await assert.rejects(worker.run('unparse', tree, call), /ENOENT/);
  assert.equal(spawns, 3, 'the fallback spawns one child per call');
  worker.dispose();
});

test('repeated crashes switch to the spawn-per-call fallback', async () => {
  const { spawner, children } = probe();
  const worker = new PythonWorker({ spawn: spawner, crashLimit: 1 });
  await worker.run('unparse', tree, call); // warm up
  const big = Array.from({ length: 20_000 }, (_, index) => `value_${index} = ${index}`).join('\n');
  const crashed = worker.run('source', big, call);
  children[0]!.kill('SIGKILL');
  await assert.rejects(crashed, /worker exited|worker stdin failed/);
  assert.equal(worker.usingFallback, true, 'the crash limit switches to the spawn-per-call fallback');
  assert.equal(await worker.run('unparse', tree, call), '');
  assert.equal(children.length, 2, 'the fallback spawns a one-shot child');
  assert.equal(worker.alive, false, 'the fallback does not keep a worker child');
  worker.dispose();
});

test('concurrent project validations keep their own roots', async () => {
  const { spawner, children } = probe();
  const worker = new PythonWorker({ spawn: spawner });
  const roots: string[] = [];
  try {
    const first = await mkdtemp(join(tmpdir(), 'jev-worker-first-'));
    const second = await mkdtemp(join(tmpdir(), 'jev-worker-second-'));
    roots.push(first, second);
    for (const root of roots) await writeFile(join(root, 'main.py'), 'from helper import run\nprint(run())\n', 'utf8');
    await mkdir(join(first, 'helper'), { recursive: true });
    await writeFile(join(first, 'helper', '__init__.py'), '', 'utf8');
    await writeFile(join(first, 'helper', 'run.py'), 'def run():\n    return 1\n', 'utf8');

    const [valid, invalid] = await Promise.all([
      worker.run('project', { root: first, paths: ['main.py', 'helper/__init__.py', 'helper/run.py'] }, call),
      worker.run('project', { root: second, paths: ['main.py'] }, call).then(() => undefined, (error: Error) => error.message),
    ]);
    assert.equal(valid, null);
    // The second root has no helper module: a leaked first root would resolve it and pass.
    assert.match(invalid ?? '', /cannot resolve import helper|shadows an installed module/);
    assert.equal(children.length, 1, 'both validations serialize through one child');
    assert.equal(await worker.run('project', { root: first, paths: ['main.py', 'helper/__init__.py', 'helper/run.py'] }, call), null,
      'the first root still validates after the second');
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    worker.dispose();
  }
});

test('disposal kills the child and rejects later calls with a clear error', async () => {
  const { spawner, children } = probe();
  const worker = new PythonWorker({ spawn: spawner });
  await worker.run('unparse', tree, call);
  worker.dispose();
  assert.ok(children[0]!.killed);
  await assert.rejects(worker.run('unparse', tree, call), /disposed/);
});

test('a run context disposes its owned worker and rejects later bridge use', async () => {
  const context = createRunContext();
  const { spawner, children } = probe();
  const worker = new PythonWorker({ spawn: spawner });
  context.setWorker(worker);
  await worker.run('unparse', tree, call);
  await context.dispose();
  assert.ok(children[0]!.killed, 'context disposal kills the worker child');
  await assert.rejects(worker.run('unparse', tree, call), /disposed/);
  assert.throws(() => context.setWorker(worker), /disposed/);
});

/** A child stand-in whose spawn handshake is emitted manually, for dispose-race tests. */
class FakeChild extends EventEmitter {
  killed = false;
  stdin = null;
  stdout = null;
  stderr = null;
  ref(): void {}
  unref(): void {}
  kill(): boolean { this.killed = true; return true; }
}

test('a spawn that resolves after dispose kills the child instead of attaching it', async () => {
  const child = new FakeChild();
  const worker = new PythonWorker({ spawn: (() => child) as never });
  const pending = worker.run('unparse', tree, call);
  worker.dispose();
  child.emit('spawn');
  await assert.rejects(pending, /disposed/);

  assert.equal(worker.alive, false, 'a disposed worker never attaches the raced child');
  assert.equal(child.killed, true, 'the raced child is killed instead of orphaned');
  assert.equal(worker.spawnCount, 1);
  worker.dispose();
});
