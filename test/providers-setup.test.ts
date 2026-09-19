import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { AstRegistry } from '../src/ast-adapters.js';
import { configPath, readConfig, writeConfig } from '../src/config.js';
import { credentialsPath, readCredentials, writeCredential } from '../src/providers/credentials.js';
import { providerFromConfig, proposeTools } from '../src/providers/index.js';
import { pick, providerCommand, wizard, type Io } from '../src/providers/setup.js';

interface Recorded { method: string; url: string; body: Record<string, unknown> }
type Handler = (req: Recorded, res: ServerResponse) => void;
interface FakeIo { io: Io; text: () => string; errText: () => string; stdin: PassThrough }

const KEY = 'topsecret-key-123456';
const never = new AbortController().signal;

const dir = async (t: test.TestContext): Promise<NodeJS.ProcessEnv> => {
  const root = await mkdtemp(join(tmpdir(), 'jev-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { JEV_CODE_CONFIG_DIR: join(root, 'cfg') };
};

const serve = async (t: test.TestContext, handler: Handler): Promise<{ baseUrl: string; reqs: Recorded[] }> => {
  const reqs: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec = { method: req.method ?? '', url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown> };
      reqs.push(rec);
      handler(rec, res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { baseUrl: `http://127.0.0.1:${port}/v1`, reqs };
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify(body));
};

const compat: Handler = (req, res) => {
  if (req.url.endsWith('/models')) return json(res, 200, { data: [{ id: 'zeta' }, { id: 'alpha' }] });
  json(res, 200, { choices: [{ message: { content: `out for ${String(req.body.model)}` }, finish_reason: 'stop' }] });
};

const fakeIo = (tty = true): FakeIo => {
  const stdin = Object.assign(new PassThrough(), { isTTY: tty, isRaw: false, setRawMode: (): void => undefined });
  const out = Object.assign(new PassThrough(), { isTTY: tty });
  const err = new PassThrough();
  const chunks: string[] = [];
  const errChunks: string[] = [];
  out.on('data', (c: Buffer) => chunks.push(String(c)));
  err.on('data', (c: Buffer) => errChunks.push(String(c)));
  return {
    io: { out: out as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, err: err as unknown as NodeJS.WriteStream },
    text: () => chunks.join(''),
    errText: () => errChunks.join(''),
    stdin,
  };
};

const waitFor = (get: () => string, needle: string): Promise<string> => new Promise(resolve => {
  const tick = (): void => {
    const s = get();
    if (s.includes(needle)) return resolve(s);
    setTimeout(tick, 5);
  };
  tick();
});

test('pick moves with arrows, selects with digits, cancels with q, and refuses without a TTY', async () => {
  const opts = ['one', 'two', 'three'];
  const down = fakeIo();
  const p1 = pick('Pick', opts, down.io);
  await waitFor(down.text, 'three');
  down.stdin.write('\x1b[B\r');
  assert.equal(await p1, 1);
  assert.match(down.text(), /Pick\n/);

  const digit = fakeIo();
  const p2 = pick('Pick', opts, digit.io);
  digit.stdin.write('2');
  assert.equal(await p2, 1);

  const quit = fakeIo();
  const p3 = pick('Pick', opts, quit.io);
  quit.stdin.write('q');
  assert.equal(await p3, undefined);

  assert.equal(await pick('Pick', opts, fakeIo(false).io), undefined);
});

test('wizard picks openai-compatible, stores the key in credentials.json, and lists models from the server', async t => {
  const env = await dir(t);
  const { baseUrl, reqs } = await serve(t, compat);
  const fake = fakeIo();
  const done = wizard(fake.io, env);
  await waitFor(fake.text, 'Local');
  fake.stdin.write('5');
  await waitFor(fake.text, 'Base URL: ');
  fake.stdin.write(`${baseUrl}\r`);
  await waitFor(fake.text, 'API key: ');
  fake.stdin.write(`${KEY}\r`);
  await waitFor(fake.text, 'zeta');
  fake.stdin.write('\x1b[B\r');
  await done;
  assert.deepEqual((await readConfig(env)).generation, { provider: 'openai-compatible', model: 'zeta', auth: 'api_key', baseUrl });
  assert.deepEqual(await readCredentials(env), { 'openai-compatible': { type: 'api_key', key: KEY } });
  assert.ok(!(await readFile(configPath(env), 'utf8')).includes(KEY));
  assert.equal(reqs.filter(r => r.url.endsWith('/models')).length, 1);
  assert.match(fake.text(), new RegExp(`Configured openai-compatible \\(zeta\\)\\. Settings in .*config\\.json, credential in .*credentials\\.json\\.`));
  assert.ok(!fake.text().includes(KEY));
});

test('wizard cancel throws setup cancelled', async t => {
  const env = await dir(t);
  const fake = fakeIo();
  const done = wizard(fake.io, env);
  await waitFor(fake.text, 'Local');
  fake.stdin.write('q');
  await assert.rejects(done, /setup cancelled/);
  assert.equal((await readConfig(env)).generation, undefined);
});

test('providerFromConfig returns undefined without config, for none, and for a missing credential', async t => {
  const env = await dir(t);
  const warned: string[] = [];
  const warn = (line: string): void => { warned.push(line); };
  assert.equal(await providerFromConfig(env, warn), undefined);
  await writeConfig({ generation: { provider: 'none' } }, env);
  assert.equal(await providerFromConfig(env, warn), undefined);
  assert.deepEqual(warned, []);
  await writeConfig({ generation: { provider: 'anthropic', model: 'claude-3-5-haiku-latest', auth: 'api_key' } }, env);
  assert.equal(await providerFromConfig(env, warn), undefined);
  assert.deepEqual(warned, ['No credential for anthropic; propose disabled. Run jev-code provider login anthropic.']);
});

test('providerFromConfig generate issues count completion requests with the KTD9 prompt', async t => {
  const env = await dir(t);
  const { baseUrl, reqs } = await serve(t, compat);
  await writeConfig({ generation: { provider: 'openai-compatible', model: 'tiny', auth: 'api_key', baseUrl } }, env);
  await writeCredential('openai-compatible', { type: 'api_key', key: KEY }, env);
  const provider = await providerFromConfig(env);
  assert.ok(provider);
  assert.equal(provider.id, 'openai-compatible');
  assert.equal(provider.model, 'tiny');
  const out = await provider.generate({ kind: 'file', objective: 'add f', constraints: 'no imports', count: 3, path: 'calc.py', current: 'x = 1\n' }, never);
  assert.equal(out.length, 3);
  assert.equal(reqs.length, 3);
  assert.ok(reqs.every(r => r.url.endsWith('/chat/completions') && r.body.model === 'tiny'));
  const msgs = reqs[0]!.body.messages as Array<{ role: string; content: string }>;
  assert.equal(msgs[0]!.content, 'You produce candidate content only. Output exactly the requested content with no explanation, no code fences, and no JSON or shell wrapper around it. Output the complete source code of the file calc.py; the output must be valid code for that file type, not prose.');
  assert.equal(msgs[1]!.content, 'Objective: add f\nConstraints: no imports\nPath: calc.py\nCurrent content:\nx = 1\n');
  assert.equal(reqs[0]!.body.temperature, undefined);
});

test('proposeTools is empty without a provider and holds propose with one', async t => {
  const env = await dir(t);
  const { baseUrl } = await serve(t, compat);
  const registry = new AstRegistry();
  assert.deepEqual(await proposeTools(env, registry), []);
  await writeConfig({ generation: { provider: 'openai-compatible', model: 'tiny', auth: 'api_key', baseUrl } }, env);
  await writeCredential('openai-compatible', { type: 'api_key', key: KEY }, env);
  const tools = await proposeTools(env, registry);
  assert.deepEqual(tools.map(tool => tool.name), ['propose']);
});

test('provider use rejects unknown ids, writes the none sentinel, and requires a credential', async t => {
  const env = await dir(t);
  const bad = fakeIo();
  assert.equal(await providerCommand(['use', 'nonesuch'], bad.io, env), 1);
  assert.equal(bad.errText(), 'Unknown provider: nonesuch. Known: openai, anthropic, google, openrouter, openai-compatible, local, none.\n');

  const none = fakeIo();
  assert.equal(await providerCommand(['use', 'none'], none.io, env), 0);
  assert.deepEqual((await readConfig(env)).generation, { provider: 'none' });

  const noCred = fakeIo();
  assert.equal(await providerCommand(['use', 'anthropic'], noCred.io, env), 1);
  assert.equal(noCred.errText(), 'No credential for anthropic. Run jev-code provider login anthropic.\n');

  await writeCredential('anthropic', { type: 'api_key', key: KEY }, env);
  const quiet = fakeIo(false);
  assert.equal(await providerCommand(['use', 'anthropic'], quiet.io, env), 0);
  assert.deepEqual((await readConfig(env)).generation, { provider: 'anthropic', auth: 'api_key', baseUrl: null });
  assert.match(quiet.text(), /No model set; run jev-code provider use anthropic --model <id>\./);
  assert.equal(await providerCommand(['use'], quiet.io, env), 1);

  const ok = fakeIo();
  const picked = providerCommand(['use', 'anthropic'], ok.io, env);
  await waitFor(ok.text, 'claude-3-5-haiku-latest');
  ok.stdin.write('2');
  assert.equal(await picked, 0);
  assert.equal((await readConfig(env)).generation?.model, 'claude-3-5-haiku-latest');
  assert.match(ok.text(), /Generation provider set to anthropic \(claude-3-5-haiku-latest\)\./);

  const chooser = fakeIo();
  const chosen = providerCommand(['use'], chooser.io, env);
  await waitFor(chooser.text, 'Generation provider');
  assert.ok(!chooser.text().includes('OpenAI (openai)'));
  chooser.stdin.write('1');
  assert.equal(await chosen, 0);
  assert.equal((await readConfig(env)).generation?.provider, 'anthropic');

  const usage = fakeIo();
  assert.equal(await providerCommand(['bogus'], usage.io, env), 1);
  assert.match(usage.errText(), /provider login/);
});

test('provider list marks the configured provider and signed-in credentials; logout removes only the credential', async t => {
  const env = await dir(t);
  await writeConfig({ apiKey: 'jev-key', generation: { provider: 'openai', model: 'gpt-5-nano', auth: 'api_key' } }, env);
  await writeCredential('openai', { type: 'api_key', key: KEY }, env);
  await writeCredential('google', { type: 'api_key', key: 'g' }, env);
  const list = fakeIo();
  assert.equal(await providerCommand(['list'], list.io, env), 0);
  const rows = list.text().trimEnd().split('\n');
  assert.equal(rows.length, 6);
  assert.match(rows[0]!, /^\* openai\tOpenAI\toauth\/api_key\tsigned in$/);
  assert.match(rows[1]!, /^ {2}anthropic\tAnthropic\toauth\/api_key\t$/);
  assert.match(rows[2]!, /^ {2}google\tGoogle\tapi_key\tsigned in$/);

  const out = fakeIo();
  assert.equal(await providerCommand(['logout'], out.io, env), 0);
  assert.deepEqual(await readCredentials(env), { google: { type: 'api_key', key: 'g' } });
  assert.deepEqual(await readConfig(env), { apiKey: 'jev-key', generation: { provider: 'openai', model: 'gpt-5-nano', auth: 'api_key' } });
  assert.match(out.text(), /Signed out of openai\./);
  assert.ok((await readFile(credentialsPath(env), 'utf8')).length > 0);
});

test('provider models lists bundled then discovered ids and needs a credential', async t => {
  const env = await dir(t);
  const { baseUrl } = await serve(t, compat);
  const missing = fakeIo();
  assert.equal(await providerCommand(['models', 'openai'], missing.io, env), 1);
  assert.equal(missing.errText(), 'No credential for openai. Run jev-code provider login openai.\n');
  await writeConfig({ generation: { provider: 'openai-compatible', model: 'tiny', auth: 'api_key', baseUrl } }, env);
  await writeCredential('openai-compatible', { type: 'api_key', key: KEY }, env);
  const ok = fakeIo();
  assert.equal(await providerCommand(['models'], ok.io, env), 0);
  assert.equal(ok.text(), 'alpha\nzeta\n');
});

test('generate keeps the good candidates when one request fails and refreshes nothing for an api key', async t => {
  const env = await dir(t);
  let n = 0;
  const { baseUrl, reqs } = await serve(t, (req, res) => {
    if (n++ === 1) return json(res, 500, { error: 'boom', headers: { authorization: `Bearer ${KEY}` } });
    compat(req, res);
  });
  await writeConfig({ generation: { provider: 'openai-compatible', model: 'tiny', auth: 'api_key', baseUrl } }, env);
  await writeCredential('openai-compatible', { type: 'api_key', key: KEY }, env);
  const provider = (await providerFromConfig(env))!;
  const out = await provider.generate({ kind: 'text', objective: 'say hi', constraints: '', count: 3 }, never);
  assert.equal(out.length, 3);
  assert.equal(out.filter(c => 'error' in c).length, 1);
  const failed = out.find(c => 'error' in c) as { error: string };
  assert.match(failed.error, /500/);
  assert.ok(!failed.error.includes(KEY));
  assert.equal(reqs.length, 3);
});

test('provider login <id> skips the provider pick and use accepts --model and --base-url', async t => {
  const env = await dir(t);
  const { baseUrl } = await serve(t, compat);
  const fake = fakeIo();
  const done = providerCommand(['login', 'openai-compatible'], fake.io, env);
  await waitFor(fake.text, 'Base URL: ');
  assert.ok(!fake.text().includes('Select generation provider'));
  fake.stdin.write(`${baseUrl}\r`);
  await waitFor(fake.text, 'API key: ');
  fake.stdin.write(`${KEY}\r`);
  await waitFor(fake.text, 'zeta');
  fake.stdin.write('\r');
  assert.equal(await done, 0);
  assert.equal((await readConfig(env)).generation?.provider, 'openai-compatible');
  const quiet = fakeIo();
  assert.equal(await providerCommand(['use', 'openai-compatible', '--model', 'omega', '--base-url', 'http://127.0.0.1:1/v1'], quiet.io, env), 0);
  assert.deepEqual((await readConfig(env)).generation, { provider: 'openai-compatible', auth: 'api_key', baseUrl: 'http://127.0.0.1:1/v1', model: 'omega' });
  assert.equal(await providerCommand(['use', 'openai-compatible', '--model'], quiet.io, env), 1);
  assert.equal(await providerCommand(['use', 'openai-compatible', '--bogus', 'x'], quiet.io, env), 1);
});

test('provider list --json and models --json emit machine-readable output', async t => {
  const env = await dir(t);
  const { baseUrl } = await serve(t, compat);
  await writeConfig({ generation: { provider: 'openai-compatible', model: 'zeta', auth: 'api_key', baseUrl } }, env);
  await writeCredential('openai-compatible', { type: 'api_key', key: KEY }, env);
  const fake = fakeIo();
  assert.equal(await providerCommand(['list', '--json'], fake.io, env), 0);
  const rows = JSON.parse(fake.text()) as Array<{ id: string; active: boolean; signedIn: boolean; model: string | null }>;
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.find(r => r.id === 'openai-compatible'), { id: 'openai-compatible', name: 'OpenAI-compatible', auth: ['api_key'], active: true, signedIn: true, model: 'zeta' });
  const more = fakeIo();
  assert.equal(await providerCommand(['models', '--json'], more.io, env), 0);
  assert.deepEqual(JSON.parse(more.text()), ['alpha', 'zeta']);
  assert.equal(await providerCommand(['use', 'none', '--json'], more.io, env), 1);
});
