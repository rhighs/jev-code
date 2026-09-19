import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthMethod } from './providers/types.js';
import { isInteractiveTTY } from './terminal-style.js';

export interface Generation { provider: string; model?: string; auth?: AuthMethod; baseUrl?: string | null }
export interface Config { apiKey?: string; generation?: Generation }

export const configDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.JEV_CODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'jev-code');
export const configPath = (env: NodeJS.ProcessEnv = process.env): string => join(configDir(env), 'config.json');

const isGeneration = (val: unknown): val is Generation =>
  !!val && typeof val === 'object' && typeof (val as Record<string, unknown>).provider === 'string';

export async function readConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  try {
    const parsed = JSON.parse(await readFile(configPath(env), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const { apiKey, generation } = parsed as Record<string, unknown>;
    const cfg: Config = typeof apiKey === 'string' && apiKey ? { apiKey } : {};
    if (isGeneration(generation)) cfg.generation = generation;
    return cfg;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

export async function writeSecretJson(path: string, val: unknown, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  await mkdir(configDir(env), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(val, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  return path;
}

export async function writeConfig(cfg: Config, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return writeSecretJson(configPath(env), cfg, env);
}

type Tty = { isTTY?: boolean };
type SecretInput = NodeJS.ReadStream & Tty;

export function promptSecret(question: string, stdin: SecretInput = process.stdin, out: NodeJS.WriteStream = process.stderr): Promise<string | undefined> {
  if (!isInteractiveTTY(stdin, out)) return Promise.resolve(undefined);
  out.write(question);
  return new Promise(resolve => {
    let buf = '';
    const wasRaw = stdin.isRaw ?? false;
    const finish = (val: string | undefined): void => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      out.write('\n');
      resolve(val);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of String(chunk)) {
        if (ch === '' || ch === '') return finish(undefined);
        if (ch === '\r' || ch === '\n') return finish(buf.trim() || undefined);
        if (ch === '' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch >= ' ') buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export const NO_KEY = 'No API key. Run `jev-code login`, or set TYPESAFE_API_KEY.';

export async function resolveApiKey(ask: () => Promise<string | undefined>, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY;
  const cfg = await readConfig(env);
  if (cfg.apiKey) return cfg.apiKey;
  const key = await ask();
  if (!key) return undefined;
  await writeConfig({ ...cfg, apiKey: key }, env);
  return key;
}
