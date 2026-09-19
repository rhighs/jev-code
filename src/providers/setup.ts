import { configPath, promptSecret, readConfig, writeConfig, type Config, type Generation } from '../config.js';
import { isInteractiveTTY } from '../terminal-style.js';
import { PROVIDERS, providerSpec, resolveWire } from './catalog.js';
import { credentialFor, credentialsPath, readCredentials } from './credentials.js';
import { authFor } from './oauth.js';
import type { AuthMethod, Credential, ProviderSpec } from './types.js';
import { listModels } from './wire.js';

export interface Io { out: NodeJS.WriteStream; stdin: NodeJS.ReadStream; err?: NodeJS.WriteStream; open?: (url: string) => Promise<void> }

const AUTH_LABELS: Record<AuthMethod, string> = {
  oauth: 'Sign in with OAuth (vendor terms apply)',
  api_key: 'Use API key',
  none: 'No authentication',
};
const USAGE = 'Use provider login [id], provider logout [id], provider list, provider models [id], or provider use <id|none>.';
const noCredential = (id: string): string => `No credential for ${id}. Run jev-code provider login ${id}.`;

export function pick(title: string, options: string[], io: Io): Promise<number | undefined> {
  if (!isInteractiveTTY(io.stdin, io.out)) return Promise.resolve(undefined);
  const { stdin, out } = io;
  let idx = 0;
  const render = (): void => { out.write(options.map((o, i) => `${i === idx ? '>' : ' '} ${i + 1}. ${o}\n`).join('')); };
  out.write(`${title}\n`);
  render();
  return new Promise(resolve => {
    const wasRaw = stdin.isRaw ?? false;
    const finish = (val: number | undefined): void => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(val);
    };
    const move = (d: number): void => {
      idx = (idx + d + options.length) % options.length;
      out.write(`\x1b[${options.length}A`);
      render();
    };
    const onData = (chunk: Buffer | string): void => {
      const s = String(chunk);
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;
        if (ch === '\x1b') {
          const seq = s.slice(i, i + 3);
          if (seq === '\x1b[A') { move(-1); i += 2; continue; }
          if (seq === '\x1b[B') { move(1); i += 2; continue; }
          return finish(undefined);
        }
        if (ch === '\x03' || ch === 'q') return finish(undefined);
        if (ch === 'k') { move(-1); continue; }
        if (ch === 'j') { move(1); continue; }
        if (ch === '\r' || ch === '\n') return finish(idx);
        if (ch >= '1' && ch <= '9' && Number(ch) <= options.length) return finish(Number(ch) - 1);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

const cancelled = (): never => { throw new Error('setup cancelled'); };

const withBase = (spec: ProviderSpec, baseUrl: string | null | undefined): ProviderSpec => baseUrl ? { ...spec, baseUrl } : spec;

const anonymous = (spec: ProviderSpec): Credential | undefined => spec.auth.includes('none') ? { type: 'none' } : undefined;

const modelIds = async (spec: ProviderSpec, cred: Credential, io: Io): Promise<string[]> => {
  const ids = await listModels(spec, cred, AbortSignal.timeout(15_000));
  if (ids) return ids;
  if (resolveWire(spec, cred).discover) io.out.write('Could not list models; showing bundled defaults.\n');
  return spec.models.map(m => m.id);
};

export async function wizard(io: Io, env: NodeJS.ProcessEnv = process.env, presetId?: string): Promise<void> {
  const pidx = presetId === undefined ? await pick('Generation provider', PROVIDERS.map(p => `${p.name} (${p.id})`), io) ?? cancelled() : undefined;
  const base = presetId === undefined ? PROVIDERS[pidx!]! : providerSpec(presetId);
  const aidx = base.auth.length === 1 ? 0 : await pick('Authentication', base.auth.map(m => AUTH_LABELS[m]), io) ?? cancelled();
  const method = base.auth[aidx]!;
  const baseUrl = base.id === 'openai-compatible' ? (await promptSecret('Base URL: ', io.stdin, io.out) ?? cancelled()).replace(/\/+$/, '') : null;
  const spec = withBase(base, baseUrl);
  const auth = authFor(spec, env, method);
  await auth.login(io);
  const cred = await auth.credential() ?? cancelled();
  const ids = await modelIds(spec, cred, io);
  const model = ids.length ? ids[await pick('Model', ids, io) ?? cancelled()]! : await promptSecret('Model id: ', io.stdin, io.out) ?? cancelled();
  const cfg = await readConfig(env);
  const generation: Generation = { provider: spec.id, model, auth: method, baseUrl };
  await writeConfig({ ...cfg, generation }, env);
  io.out.write(`Configured ${spec.id} (${model}). Settings in ${configPath(env)}, credential in ${credentialsPath(env)}.\n`);
}

const configured = (cfg: Config): string | undefined => cfg.generation && cfg.generation.provider !== 'none' ? cfg.generation.provider : undefined;

const list = async (cfg: Config, env: NodeJS.ProcessEnv, io: Io): Promise<number> => {
  const creds = await readCredentials(env);
  for (const p of PROVIDERS) {
    const mark = configured(cfg) === p.id ? '*' : ' ';
    io.out.write(`${mark} ${p.id}\t${p.name}\t${p.auth.join('/')}\t${p.id in creds ? 'signed in' : ''}\n`);
  }
  return 0;
};

const models = async (cfg: Config, id: string, env: NodeJS.ProcessEnv, io: Io): Promise<number> => {
  const spec = withBase(providerSpec(id), cfg.generation?.provider === id ? cfg.generation.baseUrl : null);
  const cred = await credentialFor(id, env) ?? anonymous(spec);
  if (!cred) throw new Error(noCredential(id));
  for (const m of await modelIds(spec, cred, io)) io.out.write(`${m}\n`);
  return 0;
};

const use = async (cfg: Config, id: string, env: NodeJS.ProcessEnv, io: Io): Promise<number> => {
  if (id === 'none') {
    await writeConfig({ ...cfg, generation: { provider: 'none' } }, env);
    io.out.write('Generation provider set to none; propose is disabled.\n');
    return 0;
  }
  const spec = providerSpec(id);
  const cred = await credentialFor(id, env) ?? anonymous(spec);
  if (!cred) throw new Error(noCredential(id));
  const prev = cfg.generation;
  const same = prev?.provider === id;
  const keep = same || spec.models.some(m => m.id === prev?.model);
  const generation: Generation = { provider: id, auth: cred.type, baseUrl: same ? prev.baseUrl ?? null : null };
  if (keep && prev?.model) generation.model = prev.model;
  await writeConfig({ ...cfg, generation }, env);
  io.out.write(`Generation provider set to ${id}.\n`);
  if (!generation.model) io.out.write(`Model cleared; run jev-code provider login ${id} to choose one.\n`);
  return 0;
};

const logout = async (cfg: Config, id: string | undefined, env: NodeJS.ProcessEnv, io: Io): Promise<number> => {
  const target = id ?? configured(cfg);
  if (!target) throw new Error('No provider configured. Use provider logout <id>.');
  await authFor(providerSpec(target), env).logout();
  io.out.write(`Signed out of ${target}.\n`);
  return 0;
};

export async function providerCommand(args: string[], io: Io, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const err = io.err ?? process.stderr;
  const [cmd, id, ...extra] = args;
  try {
    if (extra.length) throw new Error(USAGE);
    const cfg = await readConfig(env);
    if (cmd === 'login') { await wizard(io, env, id); return 0; }
    if (cmd === 'logout') return await logout(cfg, id, env, io);
    if (cmd === 'list' && id === undefined) return await list(cfg, env, io);
    if (cmd === 'models') {
      const target = id ?? configured(cfg);
      if (!target) throw new Error('No provider configured. Use provider models <id>.');
      return await models(cfg, target, env, io);
    }
    if (cmd === 'use' && id !== undefined) return await use(cfg, id, env, io);
    throw new Error(USAGE);
  } catch (e) {
    err.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
