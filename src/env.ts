import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Project dotenv keys the application itself may read. A checkout controls its own `.env`, so
 * everything outside this list is ignored: compiler and runtime hooks (`NODE_OPTIONS`, `BASH_ENV`,
 * `PYTHONPATH`, `LD_PRELOAD`, `DYLD_*`, `BUN_*`) must never reach a validator or a spawned shell,
 * and `TYPESAFE_BASE_URL` must never redirect an authenticated request away from the destination
 * the caller chose.
 */
export const PROJECT_ENV_ALLOWLIST = new Set([
  'TYPESAFE_API_KEY',
  'TYPESAFE_DEFAULT_MODEL',
  'TYPESAFE_LOG_LEVEL',
  'NO_COLOR',
]);

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNQUOTED_COMMENT = /\s+#.*$/;

/**
 * Parse dotenv text without touching `process.env`. Supports `KEY=value`, `export KEY=value`,
 * blank lines, comments, single and double quotes, and the escape sequences Node's env-file parser
 * accepts in double-quoted values.
 */
export function parseDotenv(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    if (!KEY.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(UNQUOTED_COMMENT, '').trim();
    }
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Apply only allowlisted settings from `<dir>/.env`. Returns the keys that were applied. A missing
 * file is not an error. The parsed file never mutates the process environment directly.
 */
export async function loadProjectEnv(dir = process.cwd(), target: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(dir, '.env'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseDotenv(text))) {
    if (!PROJECT_ENV_ALLOWLIST.has(key)) continue;
    target[key] = value;
    applied.push(key);
  }
  return applied;
}

export function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.JEV_GENERATION_API_KEY;
  return env;
}
