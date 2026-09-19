import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from '../config.js';
import type { Credential } from './types.js';

export const credentialsPath = (env: NodeJS.ProcessEnv = process.env): string => join(configDir(env), 'credentials.json');

export async function readCredentials(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, Credential>> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(env), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, Credential>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof SyntaxError) return {};
    throw err;
  }
}

async function writeCredentials(creds: Record<string, Credential>, env: NodeJS.ProcessEnv): Promise<void> {
  const path = credentialsPath(env);
  await mkdir(configDir(env), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function writeCredential(id: string, cred: Credential, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const creds = await readCredentials(env);
  await writeCredentials({ ...creds, [id]: cred }, env);
}

export async function deleteCredential(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const creds = await readCredentials(env);
  if (!(id in creds)) return;
  const { [id]: _, ...rest } = creds;
  await writeCredentials(rest, env);
}

export async function credentialFor(id: string, env: NodeJS.ProcessEnv = process.env): Promise<Credential | undefined> {
  if (env.JEV_GENERATION_API_KEY) return { type: 'api_key', key: env.JEV_GENERATION_API_KEY };
  const creds = await readCredentials(env);
  return creds[id];
}
