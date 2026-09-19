import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configPath, readConfig, resolveApiKey, writeConfig } from '../src/config.js';

const dir = async (t: test.TestContext): Promise<NodeJS.ProcessEnv> => {
  const root = await mkdtemp(join(tmpdir(), 'jev-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { JEV_CODE_CONFIG_DIR: root };
};

test('the config file lives under the config dir, is written with mode 600, and reads back', async t => {
  const env = await dir(t);
  assert.deepEqual(await readConfig(env), {});
  const path = await writeConfig({ apiKey: 'k1' }, env);
  assert.equal(path, configPath(env));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readConfig(env), { apiKey: 'k1' });
  assert.match(await readFile(path, 'utf8'), /"apiKey": "k1"/);
});

test('XDG_CONFIG_HOME places the dir under jev-code when no override is set', () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: '/x' }), '/x/jev-code/config.json');
});

test('resolveApiKey prefers the environment, then the saved key, then asks once and saves the answer', async t => {
  const env = await dir(t);
  let asked = 0;
  const ask = async (): Promise<string | undefined> => { asked += 1; return 'typed'; };
  assert.equal(await resolveApiKey(ask, { ...env, TYPESAFE_API_KEY: 'env' }), 'env');
  assert.equal(asked, 0);
  assert.equal(await resolveApiKey(ask, env), 'typed');
  assert.equal(asked, 1);
  assert.deepEqual(await readConfig(env), { apiKey: 'typed' });
  assert.equal(await resolveApiKey(ask, env), 'typed');
  assert.equal(asked, 1);
  const empty = await dir(t);
  assert.equal(await resolveApiKey(async () => undefined, empty), undefined);
  assert.deepEqual(await readConfig(empty), {});
});

test('readConfig returns generation alongside apiKey and drops a generation without a string provider', async t => {
  const env = await dir(t);
  const generation = { provider: 'openai', model: 'gpt-5-nano', auth: 'api_key' as const, baseUrl: null };
  await writeConfig({ apiKey: 'k1', generation }, env);
  assert.deepEqual(await readConfig(env), { apiKey: 'k1', generation });
  await writeFile(configPath(env), JSON.stringify({ apiKey: 'k1', generation: { provider: 7 } }));
  assert.deepEqual(await readConfig(env), { apiKey: 'k1' });
});
