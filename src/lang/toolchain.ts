import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizedEnv } from '../env.js';

export interface ToolRun { name: string; signal: AbortSignal; timeout: number; cwd?: string; env?: NodeJS.ProcessEnv; missing?: string }

export const runTool = (cmd: string, args: string[], opts: ToolRun): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), env: { ...sanitizedEnv(), ...opts.env }, stdio: ['ignore', 'ignore', 'pipe'], signal: opts.signal, timeout: opts.timeout });
  let err = '';
  child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-8000); });
  child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' && opts.missing ? new Error(opts.missing) : e));
  child.on('close', code => {
    if (opts.signal.aborted) { reject(opts.signal.reason); return; }
    if (code !== 0) { reject(new Error(`${opts.name} validation failed: ${err.trim() || `exit ${code}`}`)); return; }
    resolve();
  });
});

export const withTempDir = async <T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
