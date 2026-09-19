import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { listWorkspace } from './workspace.js';
import { sanitizedEnv } from './env.js';
import { parseManifest, validatePythonProject } from './python-ast.js';
import type { Tool, ToolArgs, ToolContext, ToolResult } from './types.js';
import { StringDecoder } from 'node:string_decoder';

type Args = ToolArgs;
const text = (args: Args, key: string): string => {
  if (typeof args[key] !== 'string') throw new Error(`${key} must be a string.`);
  return args[key];
};
const number = (args: Args, key: string, fallback: number): number => {
  const value = args[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${key} must be an integer.`);
  return value;
};

interface Staged { commit(): Promise<void>; undo(): Promise<void>; done(): Promise<void> }

const unlinkQuiet = (path: string): Promise<void> => unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });

async function stage(path: string, contents: string, signal: AbortSignal, backup: boolean): Promise<Staged> {
  signal.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  const id = randomUUID();
  const temp = `${path}.jev-${id}.tmp`, saved = `${path}.jev-${id}.bak`;
  let mode = 0o644;
  let existing = false;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Cannot write ${path}: not a regular file.`);
    mode = info.mode & 0o777; existing = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    const file = await open(temp, 'wx', mode);
    try {
      if (existing) await file.chmod(mode);
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally { await file.close(); }
  } catch (error) { await unlinkQuiet(temp); throw error; }
  const keep = existing && backup;
  let phase: 'staged' | 'moved' | 'committed' = 'staged';
  return {
    commit: async () => {
      if (keep) { await rename(path, saved); phase = 'moved'; }
      await rename(temp, path); phase = 'committed';
    },
    undo: async () => {
      if (phase !== 'committed') await unlinkQuiet(temp);
      if (keep && phase !== 'staged') await rename(saved, path);
      else if (!existing && phase === 'committed') await unlinkQuiet(path);
    },
    done: async () => { if (keep) await unlinkQuiet(saved); },
  };
}

export async function atomicWrite(path: string, contents: string, signal: AbortSignal): Promise<void> {
  await atomicWriteAll([[path, contents]], signal);
}

/** Every file is staged, then renamed into place; if a rename fails, earlier renames are undone from backups, so a failure leaves the files as they were. */
export async function atomicWriteAll(entries: Array<[string, string]>, signal: AbortSignal): Promise<void> {
  const staged: Staged[] = [];
  try {
    for (const [path, contents] of entries) staged.push(await stage(path, contents, signal, entries.length > 1));
    signal.throwIfAborted();
    for (const item of staged) await item.commit();
  } catch (error) {
    for (const item of staged) await item.undo().catch(() => {});
    throw error;
  }
  for (const item of staged) await item.done();
}

export async function runBash(command: string, cwd: string, timeoutMs: number, signal: AbortSignal, maxOutputBytes = 32_000,
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => Promise<void>): Promise<ToolResult> {
  signal.throwIfAborted();
  if (!command || command.includes('\0')) throw new Error('Bash command must be nonempty and contain no NUL bytes.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Invalid Bash timeout.');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid output limit.');
  if (!(await stat(cwd)).isDirectory()) throw new Error('Bash cwd must be a directory.');
  return new Promise((resolve, reject) => {
    // The workspace is a starting directory, not an OS sandbox.
    const child = spawn('bash', ['-c', command], {
      cwd, env: sanitizedEnv(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = [];
    let stdoutRetained = 0, stderrRetained = 0;
    let stdoutBytes = 0, stderrBytes = 0;
    let timedOut = false, cancelled = false, settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let outputQueue = Promise.resolve();
    let outputError: unknown;
    let outputFailed = false;
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    const terminate = (kind: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const stop = (): void => {
      terminate('SIGTERM');
      forceTimer ??= setTimeout(() => terminate('SIGKILL'), 500);
    };
    const abort = (): void => { cancelled = true; stop(); };
    const forward = (stream: 'stdout' | 'stderr', text: string): void => {
      if (!text || !onOutput) return;
      outputQueue = outputQueue.then(() => outputFailed ? undefined : onOutput(stream, text)).catch(error => { outputFailed = true; outputError = error; stop(); });
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (data: Buffer) => {
      stdoutBytes += data.length;
      const chunk = data.subarray(0, Math.max(0, maxOutputBytes - stdoutRetained));
      if (chunk.length) { stdoutChunks.push(chunk); stdoutRetained += chunk.length; forward('stdout', stdoutDecoder.write(chunk)); }
    });
    child.stderr.on('data', (data: Buffer) => {
      stderrBytes += data.length;
      const chunk = data.subarray(0, Math.max(0, maxOutputBytes - stderrRetained));
      if (chunk.length) { stderrChunks.push(chunk); stderrRetained += chunk.length; forward('stderr', stderrDecoder.write(chunk)); }
    });
    const cleanup = (): void => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal.removeEventListener('abort', abort);
    };
    child.on('error', (error) => { if (!settled) { settled = true; cleanup(); reject(error); } });
    child.on('close', async (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      forward('stdout', stdoutDecoder.end());
      forward('stderr', stderrDecoder.end());
      await outputQueue;
      if (timedOut || cancelled || outputFailed) terminate('SIGKILL');
      cleanup();
      if (outputFailed) { reject(outputError); return; }
      const stdout = Buffer.concat(stdoutChunks, stdoutRetained);
      const stderr = Buffer.concat(stderrChunks, stderrRetained);
      const truncated = stdoutBytes > stdout.length || stderrBytes > stderr.length;
      const reason = cancelled ? 'Cancelled.' : timedOut ? `Timed out after ${timeoutMs}ms.` : '';
      resolve({
        ok: exitCode === 0 && !timedOut && !cancelled,
        output: [stdout.toString('utf8'), stderr.length ? `stderr:\n${stderr.toString('utf8')}` : '', reason,
          truncated ? '[output truncated]' : ''].filter(Boolean).join('\n'),
        data: { exitCode, signal: exitSignal, timedOut, cancelled, truncated, stdoutBytes, stderrBytes },
      });
    });
  });
}

export const autoApproved = (tool: Tool, confirmWrites: boolean | undefined): boolean => tool.effect !== 'shell' && !(confirmWrites && tool.effect === 'write');

export function builtInTools(): Tool[] {
  return [
    {
      name: 'list_files', effect: 'read', description: 'List files under a workspace directory, excluding generated/dependency directories.',
      fields: { path: { type: 'string', description: 'Directory to list. Use . for the workspace root.' } },
      async execute(args, context) {
        const inventory = await listWorkspace(await context.resolvePath(text(args, 'path')));
        return { ok: true, output: inventory.files.join('\n'), data: inventory };
      },
    },
    {
      name: 'read_file', effect: 'read', description: 'Read an existing UTF-8 file with byte offsets. Read before editing.',
      fields: {
        path: { type: 'string', description: 'File path to read.' },
        offset: { type: 'number', min: 0, default: 0, description: 'Starting byte offset. Empty means 0.' },
        limit: { type: 'number', min: 1, max: 32_000, default: 8000, description: 'Maximum bytes to read. Empty means 8000.' },
      },
      async execute(args, context) {
        const path = await context.resolvePath(text(args, 'path'));
        const offset = number(args, 'offset', 0), limit = number(args, 'limit', 8000);
        if (offset < 0 || limit < 1 || limit > 32_000) throw new Error('Invalid read range.');
        const handle = await open(path, 'r');
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw new Error('Can only read regular files.');
          const buffer = Buffer.alloc(limit);
          const { bytesRead } = await handle.read(buffer, 0, limit, offset);
          return { ok: true, output: buffer.subarray(0, bytesRead).toString('utf8'),
            data: { offset, bytesRead, totalBytes: info.size, nextOffset: offset + bytesRead, truncated: offset + bytesRead < info.size } };
        } finally { await handle.close(); }
      },
    },
    {
      name: 'write_file', effect: 'write', description: 'Atomically create or replace a UTF-8 file of any language. Creates parent directories.',
      fields: {
        path: { type: 'string', description: 'Destination file path.' },
        content: { type: 'string', allowEmpty: true, description: 'Exact complete file contents, without presentation fences.' },
      },
      async execute(args, context) {
        const path = await context.resolvePath(text(args, 'path'));
        const content = text(args, 'content');
        await atomicWrite(path, content, context.signal);
        return { ok: true, output: `Wrote ${Buffer.byteLength(content)} bytes to ${text(args, 'path')}.`, data: { path, bytes: Buffer.byteLength(content) } };
      },
    },
    {
      name: 'write_files', effect: 'write', description: 'Write a multi-module Python project (a package plus an entry script) as one validated set: all files or none. Use write_file for a single file.',
      fields: { files: { type: 'string', description: 'JSON manifest of relative .py paths to complete file contents.' } },
      async execute(args, context) {
        const files = parseManifest(text(args, 'files'));
        const targets: Array<[string, string]> = [];
        const canonical = new Map<string, string>();
        for (const [path, content] of Object.entries(files)) {
          const target = await context.resolvePath(path);
          const prior = canonical.get(target);
          if (prior !== undefined) throw new Error(`Manifest entries ${prior} and ${path} resolve to the same file.`);
          canonical.set(target, path);
          targets.push([target, content]);
        }
        await validatePythonProject(files, context.signal);
        await atomicWriteAll(targets, context.signal);
        const paths = Object.keys(files);
        return { ok: true, output: `Wrote ${paths.length} files:\n${paths.join('\n')}`, data: { paths, bytes: paths.reduce((n, path) => n + Buffer.byteLength(files[path]!), 0) } };
      },
    },
    {
      name: 'edit_file', effect: 'write', description: 'Replace exactly one occurrence of old_text. Fails if absent or ambiguous; read the file first.',
      fields: {
        path: { type: 'string', description: 'Existing file path.' },
        old_text: { type: 'string', description: 'Exact text to replace, including whitespace; must occur exactly once.' },
        new_text: { type: 'string', allowEmpty: true, description: 'Exact replacement text. Empty deletes old_text.' },
      },
      async execute(args, context) {
        const path = await context.resolvePath(text(args, 'path'));
        const info = await lstat(path);
        if (!info.isFile() || info.size > 2_000_000) throw new Error('Edit requires a regular file of at most 2MB.');
        const source = await readFile(path, 'utf8');
        const old = text(args, 'old_text');
        const at = source.indexOf(old);
        if (!old || at < 0 || source.indexOf(old, at + 1) >= 0) throw new Error('old_text must occur exactly once; read the file and try a more specific edit.');
        const replacement = text(args, 'new_text');
        await atomicWrite(path, source.slice(0, at) + replacement + source.slice(at + old.length), context.signal);
        return { ok: true, output: `Edited ${text(args, 'path')}.` };
      },
    },
    {
      name: 'bash', effect: 'shell', description: 'Execute any Bash command, including pipelines, scripts, installs, and tests. Observe the exit status and repair failures.',
      fields: {
        command: { type: 'string', description: 'Exact Bash command to execute.' },
        cwd: { type: 'string', description: 'Working directory relative to workspace; use . for its root.' },
        timeout_ms: { type: 'number', min: 1, max: 600_000, default: 30_000, description: 'Timeout in milliseconds. Empty means 30000.' },
      },
      async execute(args, context) {
        return runBash(text(args, 'command'), await context.resolvePath(text(args, 'cwd')), number(args, 'timeout_ms', 30_000), context.signal, 32_000, context.onOutput);
      },
    },
    {
      name: 'set_plan', effect: 'read', description: 'Record or revise a short plan and progress. Adapt it when requirements or tool results change.',
      fields: { plan: { type: 'string', description: 'Current steps with their statuses, concrete next action, and known blockers.' } },
      async execute(args) { return { ok: true, output: text(args, 'plan'), data: { plan: text(args, 'plan') } }; },
    },
  ];
}

/** Public host API uses the same tools as Jev; helpers do not bypass path policy. */
export function toolContext(workspace: string, signal: AbortSignal, resolvePath: ToolContext['resolvePath']): ToolContext {
  return { workspace, signal, resolvePath };
}
