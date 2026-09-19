import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promptSecret } from '../config.js';
import { credentialFor, deleteCredential, writeCredential } from './credentials.js';
import type { AuthMethod, Credential, OAuthDescriptor, ProviderAuth, ProviderIo, ProviderSpec } from './types.js';
import { scrub } from './wire.js';

type OAuthCred = Extract<Credential, { type: 'oauth' }>;
type Body = Record<string, unknown>;

export interface Pkce { verifier: string; challenge: string; state: string }
export interface AuthorizeOpts { io: ProviderIo; timeoutMs?: number; port?: number; onListen?: (addr: AddressInfo) => void }
export interface Authorized { code: string; verifier: string; state: string; redirectUri: string }

const PAGE = '<!doctype html><html><body><p>Signed in. You can close this tab.</p></body></html>';
const PASTE_HOST = 'https://console.anthropic.com';

export const pkce = (): Pkce => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(16).toString('base64url') };
};

const authorizeUrl = (desc: OAuthDescriptor, redirectUri: string, p: Pkce): string => {
  const url = new URL(desc.authorizeUrl);
  const q = url.searchParams;
  q.set('code_challenge', p.challenge);
  q.set('code_challenge_method', 'S256');
  if (desc.exchange === 'key') {
    q.set('callback_url', redirectUri);
    return url.toString();
  }
  q.set('response_type', 'code');
  q.set('client_id', desc.clientId);
  q.set('redirect_uri', redirectUri);
  q.set('scope', desc.scopes.join(' '));
  q.set('state', p.state);
  return url.toString();
};

const announce = async (io: ProviderIo, url: string): Promise<void> => {
  io.out.write(`Open this URL to sign in:\n${url}\n`);
  try { await io.open?.(url); } catch { return; }
};

const loopback = (desc: OAuthDescriptor, opts: AuthorizeOpts, p: Pkce): Promise<Authorized> => new Promise((resolve, reject) => {
  const port = opts.port ?? desc.port ?? 0;
  let redirectUri = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const q = url.searchParams;
    const reply = (status: number, body: string): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(body);
    };
    if (url.pathname !== desc.callbackPath) return reply(404, 'Not found');
    const err = q.get('error');
    if (err) {
      reply(400, 'Sign-in failed. Return to the terminal.');
      return finish(() => reject(new Error(`${err}: ${q.get('error_description') ?? ''}`)));
    }
    if (desc.state && q.get('state') !== p.state) return reply(400, 'state mismatch');
    const code = q.get('code');
    if (!code) return reply(400, 'missing code');
    reply(200, PAGE);
    finish(() => resolve({ code, verifier: p.verifier, state: p.state, redirectUri }));
  });
  const timer = setTimeout(() => finish(() => reject(new Error('OAuth login timed out'))), opts.timeoutMs ?? 120_000);
  const finish = (done: () => void): void => {
    clearTimeout(timer);
    server.close();
    done();
  };
  server.on('error', (err: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    if (err.code === 'EADDRINUSE') return reject(new Error(`Port ${port} is in use; run login again and paste the redirect URL when prompted`));
    reject(err);
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address() as AddressInfo;
    opts.onListen?.(addr);
    redirectUri = `http://localhost:${addr.port}${desc.callbackPath}`;
    void announce(opts.io, authorizeUrl(desc, redirectUri, p));
  });
});

const parsePaste = (input: string): { code: string; state?: string } => {
  if (input.startsWith('http')) {
    const q = new URL(input).searchParams;
    const code = q.get('code');
    if (!code) throw new Error('no code in redirect URL');
    const state = q.get('state');
    return state ? { code, state } : { code };
  }
  const at = input.indexOf('#');
  if (at < 0) return { code: input };
  return { code: input.slice(0, at), state: input.slice(at + 1) };
};

const pasted = async (desc: OAuthDescriptor, io: ProviderIo, p: Pkce): Promise<Authorized> => {
  const redirectUri = `${PASTE_HOST}${desc.callbackPath}`;
  await announce(io, authorizeUrl(desc, redirectUri, p));
  const input = await promptSecret('Paste the authorization code (or the full redirect URL): ', io.stdin, io.out);
  if (!input) throw new Error('login cancelled');
  const parsed = parsePaste(input);
  if (desc.state && !parsed.state) throw new Error('state missing');
  if (desc.state && parsed.state !== p.state) throw new Error('state mismatch');
  return { code: parsed.code, verifier: p.verifier, state: p.state, redirectUri };
};

export function authorize(desc: OAuthDescriptor, opts: AuthorizeOpts): Promise<Authorized> {
  const p = pkce();
  return desc.redirect === 'loopback' ? loopback(desc, opts, p) : pasted(desc, opts.io, p);
}

const post = async (url: string, body: Body): Promise<Body> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${scrub(text.slice(0, 300), [])}`);
  return JSON.parse(text) as Body;
};

const accountOf = (idToken: unknown): string | undefined => {
  if (typeof idToken !== 'string') return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString()) as Body;
    const auth = payload['https://api.openai.com/auth'] as Body | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
};

const tokenCred = (body: Body, prev?: OAuthCred): OAuthCred => {
  if (typeof body.access_token !== 'string') throw new Error('token response has no access_token');
  const cred: OAuthCred = { type: 'oauth', access: body.access_token };
  const refreshTok = typeof body.refresh_token === 'string' ? body.refresh_token : prev?.refresh;
  if (refreshTok) cred.refresh = refreshTok;
  if (typeof body.expires_in === 'number') cred.expires = Date.now() + body.expires_in * 1000 - 60_000;
  const account = accountOf(body.id_token) ?? prev?.account;
  if (account) cred.account = account;
  return cred;
};

export async function exchange(desc: OAuthDescriptor, code: string, verifier: string, redirectUri: string, state?: string): Promise<Credential> {
  if (desc.exchange === 'key') {
    const body = await post(desc.tokenUrl, { code, code_verifier: verifier, code_challenge_method: 'S256' });
    if (typeof body.key !== 'string') throw new Error('key response has no key');
    return { type: 'api_key', key: body.key };
  }
  const body = await post(desc.tokenUrl, {
    grant_type: 'authorization_code', client_id: desc.clientId, code, code_verifier: verifier, redirect_uri: redirectUri,
    ...(state ? { state } : {}),
  });
  return tokenCred(body);
}

export async function refresh(desc: OAuthDescriptor, cred: OAuthCred): Promise<OAuthCred> {
  if (!cred.refresh) throw new Error('credential has no refresh token');
  const body = await post(desc.tokenUrl, { grant_type: 'refresh_token', client_id: desc.clientId, refresh_token: cred.refresh });
  return tokenCred(body, cred);
}

const inflight = new Map<string, Promise<OAuthCred>>();
const loginMsg = (id: string): string => `${id} authentication failed. Run jev-code provider login ${id}.`;

const renew = (spec: ProviderSpec, cred: OAuthCred, env: NodeJS.ProcessEnv): Promise<OAuthCred> => {
  const cur = inflight.get(spec.id);
  if (cur) return cur;
  const desc = spec.oauth;
  const p = (desc ? refresh(desc, cred) : Promise.reject<OAuthCred>(new Error(loginMsg(spec.id))))
    .then(async fresh => { await writeCredential(spec.id, fresh, env); return fresh; })
    .catch(() => { throw new Error(loginMsg(spec.id)); })
    .finally(() => inflight.delete(spec.id));
  inflight.set(spec.id, p);
  return p;
};

const is401 = (err: unknown): boolean => err instanceof Error && err.message.includes(' 401');

export async function withFreshToken<T>(spec: ProviderSpec, cred: Credential, env: NodeJS.ProcessEnv, fn: (cred: Credential) => Promise<T>): Promise<T> {
  if (cred.type !== 'oauth') return fn(cred);
  const cur = cred.expires !== undefined && cred.expires <= Date.now() ? await renew(spec, cred, env) : cred;
  try {
    return await fn(cur);
  } catch (err) {
    if (!is401(err)) throw err;
    const fresh = await renew(spec, cur, env);
    try {
      return await fn(fresh);
    } catch (again) {
      if (is401(again)) throw new Error(loginMsg(spec.id));
      throw again;
    }
  }
}

const obtain = async (spec: ProviderSpec, method: AuthMethod, io: ProviderIo): Promise<Credential> => {
  if (method === 'none') return { type: 'none' };
  if (method === 'api_key') {
    const key = await promptSecret(`Paste your ${spec.name} API key: `, io.stdin, io.out);
    if (!key) throw new Error('login cancelled');
    return { type: 'api_key', key };
  }
  const desc = spec.oauth;
  if (!desc) throw new Error(`${spec.id} does not support OAuth`);
  const { code, verifier, state, redirectUri } = await authorize(desc, { io });
  return exchange(desc, code, verifier, redirectUri, desc.state ? state : undefined);
};

export const authFor = (spec: ProviderSpec, env: NodeJS.ProcessEnv = process.env, method: AuthMethod = spec.auth[0] ?? 'api_key'): ProviderAuth => ({
  login: async io => { await writeCredential(spec.id, await obtain(spec, method, io), env); },
  logout: () => deleteCredential(spec.id, env),
  credential: () => credentialFor(spec.id, env),
});
