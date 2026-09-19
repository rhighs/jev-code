import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { credentialFor, credentialsPath, deleteCredential, readCredentials, writeCredential } from '../src/providers/credentials.js';

const dir = async (t: test.TestContext): Promise<NodeJS.ProcessEnv> => {
  const root = await mkdtemp(join(tmpdir(), 'jev-creds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { JEV_CODE_CONFIG_DIR: join(root, 'cfg') };
};

test('credentials round-trip through a 0600 file inside a 0700 directory', async t => {
  const env = await dir(t);
  assert.deepEqual(await readCredentials(env), {});
  await writeCredential('openai', { type: 'oauth', access: 'a', refresh: 'r', expires: 1 }, env);
  await writeCredential('local', { type: 'none' }, env);
  assert.equal((await stat(credentialsPath(env))).mode & 0o777, 0o600);
  assert.equal((await stat(env.JEV_CODE_CONFIG_DIR!)).mode & 0o777, 0o700);
  assert.deepEqual(await readCredentials(env), {
    openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
    local: { type: 'none' },
  });
  assert.deepEqual(await credentialFor('local', env), { type: 'none' });
});

test('deleteCredential removes only the named id and ignores absent ones', async t => {
  const env = await dir(t);
  await deleteCredential('openai', env);
  assert.deepEqual(await readCredentials(env), {});
  await writeCredential('openai', { type: 'api_key', key: 'k' }, env);
  await writeCredential('google', { type: 'api_key', key: 'g' }, env);
  await deleteCredential('openai', env);
  assert.deepEqual(await readCredentials(env), { google: { type: 'api_key', key: 'g' } });
  await deleteCredential('nonesuch', env);
  assert.deepEqual(await readCredentials(env), { google: { type: 'api_key', key: 'g' } });
});

test('JEV_GENERATION_API_KEY wins without reading the credentials file', async t => {
  const env = await dir(t);
  const cred = await credentialFor('openai', { ...env, JEV_GENERATION_API_KEY: 'k' });
  assert.deepEqual(cred, { type: 'api_key', key: 'k' });
  await assert.rejects(stat(env.JEV_CODE_CONFIG_DIR!), { code: 'ENOENT' });
  assert.equal(await credentialFor('openai', env), undefined);
});

test('a malformed credentials file reads as empty', async t => {
  const env = await dir(t);
  await writeCredential('openai', { type: 'api_key', key: 'k' }, env);
  await writeFile(credentialsPath(env), '[1, 2]');
  assert.deepEqual(await readCredentials(env), {});
  await writeFile(credentialsPath(env), '{ not json');
  assert.deepEqual(await readCredentials(env), {});
  assert.equal(await credentialFor('openai', env), undefined);
});
