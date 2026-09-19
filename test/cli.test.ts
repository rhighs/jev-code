import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = resolve('src/cli.ts');
const tsx = resolve('node_modules/.bin/tsx');

test('removed provider command and proposal option are rejected', async () => {
  await assert.rejects(run(tsx, [cli, 'provider', 'list'], { cwd: resolve('.') }),
    (error: Error & { code?: unknown; stderr?: string }) => error.code === 1 && /Unknown command: provider/.test(error.stderr ?? ''));
  await assert.rejects(run(tsx, [cli, '--max-proposals', '1', '--print', 'task'], {
    cwd: resolve('.'), env: { ...process.env, TYPESAFE_API_KEY: 'unused' },
  }), (error: Error & { code?: unknown; stderr?: string }) => error.code === 1 && /Unknown option '--max-proposals'/.test(error.stderr ?? ''));
});

test('help exposes only the Jev API-key login flow', async () => {
  const { stdout } = await run(tsx, [cli, '--help'], { cwd: resolve('.') });
  assert.match(stdout, /login\s+Enter your typesafe\.ai API key/);
  assert.doesNotMatch(stdout, /max-proposals|generation provider|provider login/);
});
