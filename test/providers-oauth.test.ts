import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { providerSpec } from '../src/providers/catalog.js';
import { readCredentials, writeCredential } from '../src/providers/credentials.js';
import { authFor, authorize, exchange, pkce, refresh, withFreshToken } from '../src/providers/oauth.js';
import type { Credential, OAuthDescriptor, ProviderIo, ProviderSpec } from '../src/providers/types.js';

interface Recorded { method: string; url: string; body: Record<string, unknown> }
type Handler = (req: Recorded, res: ServerResponse) => void;

const openaiDesc = providerSpec('openai').oauth!;
const anthropicDesc = providerSpec('anthropic').oauth!;
const openrouterDesc = providerSpec('openrouter').oauth!;

const dir = async (t: test.TestContext): Promise<NodeJS.ProcessEnv> => {
  const root = await mkdtemp(join(tmpdir(), 'jev-oauth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { JEV_CODE_CONFIG_DIR: join(root, 'cfg') };
};

const serve = async (t: test.TestContext, handler: Handler): Promise<{ url: string; reqs: Recorded[] }> => {
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
  return { url: `http://127.0.0.1:${port}/token`, reqs };
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify(body));
};

const idToken = (claims: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

const tokenBody = (access: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ access_token: access, refresh_token: `r-${access}`, expires_in: 3600, ...extra });

interface FakeIo { io: ProviderIo; text: () => string; stdin: PassThrough }

const fakeIo = (): FakeIo => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: (): void => undefined });
  const out = Object.assign(new PassThrough(), { isTTY: true });
  const chunks: string[] = [];
  out.on('data', (c: Buffer) => chunks.push(String(c)));
  return {
    io: { out: out as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, open: async () => undefined },
    text: () => chunks.join(''),
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

const printedUrl = async (fake: FakeIo): Promise<URL> => {
  const text = await waitFor(fake.text, 'http');
  return new URL(/https?:\/\/\S+/.exec(text)![0]);
};

const hit = (port: number, path: string, query: string): Promise<Response> => fetch(`http://127.0.0.1:${port}${path}?${query}`);

const startLoopback = async (desc: OAuthDescriptor, timeoutMs?: number): Promise<{ done: Promise<{ code: string; verifier: string }>; addr: AddressInfo; url: URL; fake: FakeIo }> => {
  const fake = fakeIo();
  let addr: AddressInfo | undefined;
  const opts = { io: fake.io, onListen: (a: AddressInfo) => { addr = a; }, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
  const done = authorize({ ...desc, port: 0 }, opts);
  const url = await printedUrl(fake);
  return { done, addr: addr!, url, fake };
};

test('pkce challenge is base64url(sha256(verifier)) and values are fresh per call', () => {
  const a = pkce();
  const b = pkce();
  assert.equal(a.challenge, createHash('sha256').update(a.verifier).digest('base64url'));
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.ok(a.state.length >= 16);
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
});

test('loopback binds 127.0.0.1, prints the authorize URL, resolves on the callback and does not reflect query text', async () => {
  const { done, addr, url } = await startLoopback(openaiDesc);
  assert.equal(addr.address, '127.0.0.1');
  assert.equal(url.origin + url.pathname, openaiDesc.authorizeUrl);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), openaiDesc.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:${addr.port}/auth/callback`);
  assert.equal(url.searchParams.get('scope'), openaiDesc.scopes.join(' '));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const state = url.searchParams.get('state')!;
  const res = await hit(addr.port, '/auth/callback', `code=abc<script>&state=${state}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /Signed in\. You can close this tab\./);
  assert.doesNotMatch(html, /abc|<script>/);
  assert.equal(html.includes(state), false);
  const result = await done;
  assert.equal(result.code, 'abc<script>');
  assert.equal(createHash('sha256').update(result.verifier).digest('base64url'), url.searchParams.get('code_challenge'));
});

test('loopback with state rejects a wrong state with 400 and keeps waiting for the right one', async () => {
  const { done, addr, url } = await startLoopback(openaiDesc);
  const bad = await hit(addr.port, '/auth/callback', 'code=abc&state=wrong');
  assert.equal(bad.status, 400);
  assert.equal(await bad.text(), 'state mismatch');
  const ok = await hit(addr.port, '/auth/callback', `code=abc&state=${url.searchParams.get('state')}`);
  assert.equal(ok.status, 200);
  assert.equal((await done).code, 'abc');
});

test('loopback without state (key exchange) builds the callback_url form and accepts a bare code', async () => {
  const { done, addr, url } = await startLoopback(openrouterDesc);
  assert.equal(url.origin + url.pathname, openrouterDesc.authorizeUrl);
  assert.equal(url.searchParams.get('callback_url'), `http://localhost:${addr.port}/callback`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.has('client_id'), false);
  assert.equal(url.searchParams.has('state'), false);
  assert.equal(url.searchParams.has('scope'), false);
  const res = await hit(addr.port, '/callback', 'code=abc');
  assert.equal(res.status, 200);
  assert.equal((await done).code, 'abc');
});

test('loopback rejects when the provider returns an error parameter', async () => {
  const { done, addr, url } = await startLoopback(openaiDesc);
  const rejected = assert.rejects(done, /^Error: access_denied: nope$/);
  const res = await hit(addr.port, '/auth/callback', `error=access_denied&error_description=nope&state=${url.searchParams.get('state')}`);
  assert.equal(res.status, 400);
  await rejected;
});

test('loopback times out', async () => {
  const { done } = await startLoopback(openaiDesc, 30);
  await assert.rejects(done, /OAuth login timed out/);
});

test('loopback reports a port in use and points at the paste path', async t => {
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const { port } = blocker.address() as AddressInfo;
  const fake = fakeIo();
  await assert.rejects(authorize({ ...openaiDesc, port }, { io: fake.io }), new RegExp(`Port ${port} is in use; run login again and paste the redirect URL when prompted`));
});

const paste = async (input: (state: string) => string): Promise<{ done: Promise<{ code: string }>; url: URL; fake: FakeIo }> => {
  const fake = fakeIo();
  const done = authorize(anthropicDesc, { io: fake.io });
  const url = await printedUrl(fake);
  await waitFor(fake.text, 'Paste the authorization code (or the full redirect URL): ');
  fake.stdin.write(`${input(url.searchParams.get('state')!)}\n`);
  return { done, url, fake };
};

test('paste mode uses the console redirect and accepts code#state', async () => {
  const { done, url } = await paste(state => `abc#${state}`);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://console.anthropic.com/oauth/code/callback');
  assert.equal(url.searchParams.get('client_id'), anthropicDesc.clientId);
  assert.equal((await done).code, 'abc');
});

test('paste mode rejects a wrong or missing state when the descriptor requires one', async () => {
  await assert.rejects((await paste(() => 'abc#wrong')).done, /^Error: state mismatch$/);
  await assert.rejects((await paste(() => 'abc')).done, /^Error: state missing$/);
});

test('paste mode accepts a full redirect URL and rejects empty input', async () => {
  const { done } = await paste(state => `http://localhost:1455/auth/callback?code=abc&state=${state}`);
  assert.equal((await done).code, 'abc');
  await assert.rejects((await paste(() => '')).done, /^Error: login cancelled$/);
});

test('exchange (token) posts the PKCE grant and returns an oauth credential expiring about 60 s early', async t => {
  const { url, reqs } = await serve(t, (_req, res) => json(res, 200, tokenBody('acc-1', { id_token: idToken({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' } }) })));
  const before = Date.now();
  const cred = await exchange({ ...openaiDesc, tokenUrl: url }, 'code-1', 'ver-1', 'http://localhost:1455/auth/callback', 'st-1');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0]!.method, 'POST');
  assert.deepEqual(reqs[0]!.body, { grant_type: 'authorization_code', client_id: openaiDesc.clientId, code: 'code-1', code_verifier: 'ver-1', redirect_uri: 'http://localhost:1455/auth/callback', state: 'st-1' });
  assert.equal(cred.type, 'oauth');
  if (cred.type !== 'oauth') return;
  assert.equal(cred.access, 'acc-1');
  assert.equal(cred.refresh, 'r-acc-1');
  assert.equal(cred.account, 'acct-42');
  const early = before + 3600_000 - 60_000;
  assert.ok(cred.expires! >= early && cred.expires! <= early + 2000, `expires ${cred.expires} not ~60 s early`);
});

test('exchange (token) without state or id_token omits state and account', async t => {
  const { url, reqs } = await serve(t, (_req, res) => json(res, 200, tokenBody('acc-2')));
  const cred = await exchange({ ...anthropicDesc, tokenUrl: url }, 'c', 'v', 'https://console.anthropic.com/oauth/code/callback');
  assert.equal('state' in reqs[0]!.body, false);
  assert.deepEqual(Object.keys(cred).sort(), ['access', 'expires', 'refresh', 'type']);
});

test('exchange (key) posts code, verifier and method and returns an api_key credential', async t => {
  const { url, reqs } = await serve(t, (_req, res) => json(res, 200, { key: 'sk-or-v1-abcdefghijkl' }));
  const cred = await exchange({ ...openrouterDesc, tokenUrl: url }, 'code-1', 'ver-1', 'http://localhost:5555/callback');
  assert.deepEqual(reqs[0]!.body, { code: 'code-1', code_verifier: 'ver-1', code_challenge_method: 'S256' });
  assert.deepEqual(cred, { type: 'api_key', key: 'sk-or-v1-abcdefghijkl' });
});

test('exchange surfaces non-2xx as host + status with a scrubbed body', async t => {
  const { url } = await serve(t, (_req, res) => json(res, 400, { error: 'invalid_grant', hint: 'Bearer leaked-token' }));
  await assert.rejects(exchange({ ...openaiDesc, tokenUrl: url }, 'c', 'v', 'r'), (err: Error) => {
    assert.match(err.message, new RegExp(`^${new URL(url).host} 400: `));
    assert.match(err.message, /invalid_grant/);
    assert.doesNotMatch(err.message, /leaked-token/);
    return true;
  });
});

test('refresh posts the refresh grant, rotates the refresh token and keeps the account', async t => {
  const { url, reqs } = await serve(t, (_req, res) => json(res, 200, tokenBody('acc-new')));
  const cred = await refresh({ ...openaiDesc, tokenUrl: url }, { type: 'oauth', access: 'old', refresh: 'r-old', expires: 1, account: 'acct-9' });
  assert.deepEqual(reqs[0]!.body, { grant_type: 'refresh_token', client_id: openaiDesc.clientId, refresh_token: 'r-old' });
  assert.equal(cred.type, 'oauth');
  if (cred.type !== 'oauth') return;
  assert.equal(cred.access, 'acc-new');
  assert.equal(cred.refresh, 'r-acc-new');
  assert.equal(cred.account, 'acct-9');
  assert.ok(cred.expires! > Date.now());
});

const oauthSpec = (tokenUrl: string): ProviderSpec => {
  const spec = providerSpec('openai');
  return { ...spec, oauth: { ...spec.oauth!, tokenUrl } };
};
const expired: Credential = { type: 'oauth', access: 'stale', refresh: 'r-stale', expires: Date.now() - 1000, account: 'acct-1' };
const live: Credential = { type: 'oauth', access: 'live', refresh: 'r-live', expires: Date.now() + 3600_000 };

test('withFreshToken refreshes an expired credential once, persists it and hands the new token to fn', async t => {
  const env = await dir(t);
  const { url, reqs } = await serve(t, (_req, res) => json(res, 200, tokenBody('fresh')));
  const seen: string[] = [];
  const out = await withFreshToken(oauthSpec(url), expired, env, async cred => { seen.push(cred.type === 'oauth' ? cred.access : ''); return 'ok'; });
  assert.equal(out, 'ok');
  assert.deepEqual(seen, ['fresh']);
  assert.equal(reqs.length, 1);
  assert.deepEqual(reqs[0]!.body, { grant_type: 'refresh_token', client_id: openaiDesc.clientId, refresh_token: 'r-stale' });
  const stored = (await readCredentials(env)).openai;
  assert.equal(stored?.type, 'oauth');
  if (stored?.type !== 'oauth') return;
  assert.equal(stored.access, 'fresh');
  assert.equal(stored.refresh, 'r-fresh');
  assert.equal(stored.account, 'acct-1');
});

test('withFreshToken shares one in-flight refresh across concurrent callers', async t => {
  const env = await dir(t);
  const { url, reqs } = await serve(t, (_req, res) => setTimeout(() => json(res, 200, tokenBody('fresh')), 20));
  const spec = oauthSpec(url);
  const outs = await Promise.all([1, 2, 3].map(n => withFreshToken(spec, expired, env, async cred => `${n}:${cred.type === 'oauth' ? cred.access : ''}`)));
  assert.deepEqual(outs, ['1:fresh', '2:fresh', '3:fresh']);
  assert.equal(reqs.length, 1);
});

test('withFreshToken refreshes and retries once on 401, then gives up with the login message', async t => {
  const env = await dir(t);
  const { url, reqs } = await serve(t, (_req, res) => json(res, 200, tokenBody('fresh')));
  const spec = oauthSpec(url);
  const calls: string[] = [];
  const out = await withFreshToken(spec, live, env, async cred => {
    const access = cred.type === 'oauth' ? cred.access : '';
    calls.push(access);
    if (access === 'live') throw new Error('openai 401: unauthorized');
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.deepEqual(calls, ['live', 'fresh']);
  assert.equal(reqs.length, 1);
  let n = 0;
  await assert.rejects(
    withFreshToken(spec, live, env, async () => { n++; throw new Error('openai 401: unauthorized'); }),
    /^Error: openai authentication failed\. Run jev-code provider login openai\.$/,
  );
  assert.equal(n, 2);
  assert.equal(reqs.length, 2);
});

test('withFreshToken passes non-401 errors through without refreshing', async t => {
  const env = await dir(t);
  const { url, reqs } = await serve(t, (_req, res) => json(res, 200, tokenBody('fresh')));
  await assert.rejects(withFreshToken(oauthSpec(url), live, env, async () => { throw new Error('openai 500: boom'); }), /^Error: openai 500: boom$/);
  assert.equal(reqs.length, 0);
});

test('withFreshToken never refreshes an api_key credential; a 401 surfaces as-is', async t => {
  const env = await dir(t);
  const { url, reqs } = await serve(t, (_req, res) => json(res, 200, tokenBody('fresh')));
  const key: Credential = { type: 'api_key', key: 'k' };
  assert.equal(await withFreshToken(oauthSpec(url), key, env, async cred => cred.type), 'api_key');
  await assert.rejects(withFreshToken(oauthSpec(url), key, env, async () => { throw new Error('openai 401: bad key'); }), /^Error: openai 401: bad key$/);
  assert.equal(reqs.length, 0);
});

test('a failed refresh throws the login message and leaves the stored credential untouched', async t => {
  const env = await dir(t);
  await writeCredential('openai', expired, env);
  const { url, reqs } = await serve(t, (_req, res) => json(res, 400, { error: 'invalid_grant' }));
  let ran = false;
  await assert.rejects(
    withFreshToken(oauthSpec(url), expired, env, async () => { ran = true; return 'no'; }),
    /^Error: openai authentication failed\. Run jev-code provider login openai\.$/,
  );
  assert.equal(ran, false);
  assert.equal(reqs.length, 1);
  assert.deepEqual((await readCredentials(env)).openai, expired);
});

test('authFor oauth login runs authorize, exchange and stores the credential', async t => {
  const env = await dir(t);
  const { url, reqs } = await serve(t, (_req, res) => json(res, 200, tokenBody('acc-login')));
  const spec = providerSpec('openai');
  const auth = authFor({ ...spec, oauth: { ...spec.oauth!, tokenUrl: url, port: 0 } }, env, 'oauth');
  const fake = fakeIo();
  const done = auth.login(fake.io);
  const authz = await printedUrl(fake);
  const redirect = new URL(authz.searchParams.get('redirect_uri')!);
  const res = await hit(Number(redirect.port), redirect.pathname, `code=abc&state=${authz.searchParams.get('state')}`);
  assert.equal(res.status, 200);
  await done;
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0]!.body.code, 'abc');
  assert.equal(reqs[0]!.body.redirect_uri, redirect.href);
  assert.equal(reqs[0]!.body.state, authz.searchParams.get('state'));
  assert.equal(createHash('sha256').update(String(reqs[0]!.body.code_verifier)).digest('base64url'), authz.searchParams.get('code_challenge'));
  const stored = await auth.credential();
  assert.equal(stored?.type, 'oauth');
  if (stored?.type !== 'oauth') return;
  assert.equal(stored.access, 'acc-login');
  await auth.logout();
  assert.equal(await auth.credential(), undefined);
  assert.deepEqual(await readCredentials(env), {});
});

test('authFor api_key login prompts for the key; none stores a none credential', async t => {
  const env = await dir(t);
  const fake = fakeIo();
  fake.stdin.write('my-key-123\n');
  await authFor(providerSpec('openai'), env, 'api_key').login(fake.io);
  assert.match(fake.text(), /Paste your OpenAI API key: /);
  assert.deepEqual((await readCredentials(env)).openai, { type: 'api_key', key: 'my-key-123' });
  await authFor(providerSpec('local'), env, 'none').login(fake.io);
  assert.deepEqual((await readCredentials(env)).local, { type: 'none' });
  const cancelled = fakeIo();
  cancelled.stdin.write('\n');
  await assert.rejects(authFor(providerSpec('openai'), env, 'api_key').login(cancelled.io), /^Error: login cancelled$/);
});
