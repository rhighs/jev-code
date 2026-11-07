import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadProjectEnv, parseDotenv, PROJECT_ENV_ALLOWLIST } from '../src/env.js';
import { JevProvider } from '../src/provider.js';

const exec = promisify(execFile);

const temp = async (t: test.TestContext): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('dotenv parsing handles exports, quotes, comments and escapes', () => {
  assert.deepEqual(parseDotenv([
    '# comment',
    'PLAIN=value',
    'export EXPORTED=one',
    'SPACED = two words ',
    'INLINE=three # trailing comment',
    'SINGLE=\'quoted # kept\'',
    'DOUBLE="line\\nbreak"',
    'invalid key=ignored',
    'NO_EQUALS',
  ].join('\n')), {
    PLAIN: 'value',
    EXPORTED: 'one',
    SPACED: 'two words',
    INLINE: 'three',
    SINGLE: 'quoted # kept',
    DOUBLE: 'line\nbreak',
  });
});

test('project dotenv applies only allowlisted settings', async t => {
  const dir = await temp(t);
  await writeFile(join(dir, '.env'), [
    'TYPESAFE_API_KEY=project-key',
    'TYPESAFE_DEFAULT_MODEL=jev-latest',
    'TYPESAFE_LOG_LEVEL=error',
    'NO_COLOR=1',
    'TYPESAFE_BASE_URL=http://127.0.0.1:1',
    'NODE_OPTIONS=--require ./marker.cjs',
    'BASH_ENV=./marker.sh',
    'PYTHONPATH=./vendor',
    'LD_PRELOAD=./evil.so',
    'DYLD_INSERT_LIBRARIES=./evil.dylib',
    'BUN_OPTIONS=--preload ./evil.ts',
    'JEV_CODE_CONFIG_DIR=./redirected-config',
  ].join('\n'));
  const target: NodeJS.ProcessEnv = {};
  const applied = await loadProjectEnv(dir, target);
  assert.deepEqual(applied.sort(), ['NO_COLOR', 'TYPESAFE_API_KEY', 'TYPESAFE_DEFAULT_MODEL', 'TYPESAFE_LOG_LEVEL']);
  assert.equal(target.TYPESAFE_API_KEY, 'project-key');
  assert.equal(target.NO_COLOR, '1');
  for (const blocked of ['TYPESAFE_BASE_URL', 'NODE_OPTIONS', 'BASH_ENV', 'PYTHONPATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BUN_OPTIONS', 'JEV_CODE_CONFIG_DIR']) {
    assert.equal(blocked in target, false, `${blocked} must not reach the process environment`);
    assert.equal(PROJECT_ENV_ALLOWLIST.has(blocked), false);
  }
});

test('a missing project dotenv file is ignored', async t => {
  const dir = await temp(t);
  assert.deepEqual(await loadProjectEnv(dir, {}), []);
});

test('an explicit provider destination wins over the environment', async () => {
  const previousBase = process.env.TYPESAFE_BASE_URL;
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_BASE_URL = 'http://127.0.0.1:1';
  process.env.TYPESAFE_API_KEY = 'environment-key';
  try {
    const urls: string[] = [];
    const provider = new JevProvider({
      baseURL: 'http://127.0.0.1:2',
      fetch: async input => {
        urls.push(String(input));
        return new Response(JSON.stringify({ answers: {}, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await provider.decide(null, { ok: { type: 'noul' } });
    assert.equal(urls[0], 'http://127.0.0.1:2/v1/systemone');
  } finally {
    if (previousBase === undefined) delete process.env.TYPESAFE_BASE_URL; else process.env.TYPESAFE_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey;
  }
});

test('project dotenv cannot redirect a saved key to another host', async t => {
  const requests: Array<{ url: string; authorization: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? '', authorization: request.headers.authorization ?? '' });
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end('{"error":"stop after the destination check"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const workspace = await temp(t);
  const config = await temp(t);
  await writeFile(join(workspace, '.env'), 'TYPESAFE_BASE_URL=http://127.0.0.1:1\n');
  await writeFile(join(config, 'config.json'), JSON.stringify({ apiKey: 'saved-key' }), { mode: 0o600 });

  const env: NodeJS.ProcessEnv = { ...process.env, TYPESAFE_BASE_URL: `http://127.0.0.1:${port}`, JEV_CODE_CONFIG_DIR: config };
  delete env.TYPESAFE_API_KEY;
  const child = spawn(process.execPath, [resolve('src/cli.ts'), 'decide', 'Is this safe?', '--choices', 'yes,no'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('The change is small.\n');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  await new Promise<void>(resolve => child.on('close', () => resolve()));

  assert.ok(requests.length >= 1, `the trusted server must receive the request; stderr: ${stderr}`);
  assert.equal(requests[0]!.url, '/v1/systemone');
  assert.equal(requests[0]!.authorization, 'Bearer saved-key');
});

test('project dotenv compiler hooks never reach a spawned CLI', async t => {
  const workspace = await temp(t);
  const marker = join(workspace, 'hook-ran');
  const hook = join(workspace, 'hook.cjs');
  await writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  await writeFile(join(workspace, '.env'), `NODE_OPTIONS=--require ${hook}\nBASH_ENV=${hook}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, JEV_CODE_CONFIG_DIR: join(workspace, 'config') };
  delete env.TYPESAFE_API_KEY;
  await exec(process.execPath, [resolve('src/cli.ts'), '--help'], { cwd: workspace, env });
  await assert.rejects(readFile(marker), 'no hook may execute');
});
