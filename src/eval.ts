import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { sanitizedEnv } from './env.js';
import { DEFAULT_LIMITS, Harness } from './harness.js';
import { formatDuration } from './timing.js';
import { builtInTools } from './tools.js';
import type { DecisionProvider, HarnessEvent } from './types.js';

export interface CheckResult { ok: boolean; reason: string }
export type Checker = (workspace: string) => Promise<CheckResult>;
export interface TaskLimits { maxTurns?: number; maxRequests?: number; maxGenerationSteps?: number; maxRunMs?: number }
export interface EvalTask { name: string; dir: string; prompt: string; stage: string; limits: TaskLimits; check: Checker }
export interface EvalRecord extends Record<string, unknown> {
  task: string; stage: string; status: string; summary: string; check: CheckResult;
  turns: number; requests: number; inputTokens: number; durationMs: number; runId: string; commit: string | null; startedAt: string;
}
export interface RunPythonOptions {
  timeoutMs: number;
  stdin?: string;
  onStart?: (write: (text: string) => void) => void;
  onLine?: (line: string, write: (text: string) => void) => void;
}
export interface RunPythonResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

export const defaultTasksDir = fileURLToPath(new URL('../eval/', import.meta.url));
const limitKeys = ['maxTurns', 'maxRequests', 'maxGenerationSteps', 'maxRunMs'] as const;

export async function loadTask(dir: string): Promise<EvalTask> {
  const raw = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')) as { prompt?: unknown; stage?: unknown; limits?: Record<string, unknown> };
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) throw new Error(`${dir}: task.json needs a prompt.`);
  if (typeof raw.stage !== 'string' || !raw.stage) throw new Error(`${dir}: task.json needs a stage.`);
  const limits: TaskLimits = {};
  for (const [k, v] of Object.entries(raw.limits ?? {})) {
    if (!(limitKeys as readonly string[]).includes(k)) throw new Error(`${dir}: unknown limit ${k}.`);
    if (!Number.isSafeInteger(v) || (v as number) < 1) throw new Error(`${dir}: limit ${k} must be a positive integer.`);
    limits[k as keyof TaskLimits] = v as number;
  }
  const mod = await import(pathToFileURL(join(dir, 'check.ts')).href) as { default?: unknown };
  if (typeof mod.default !== 'function') throw new Error(`${dir}: check.ts must default-export a checker.`);
  return { name: dir.split('/').filter(Boolean).at(-1)!, dir, prompt: raw.prompt, stage: raw.stage, limits, check: mod.default as Checker };
}

export async function loadTasks(tasksDir: string, only?: string): Promise<EvalTask[]> {
  const names = (await readdir(tasksDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  if (only !== undefined && !names.includes(only)) throw new Error(`Unknown eval task: ${only}. Available: ${names.join(', ') || 'none'}.`);
  return Promise.all(names.filter(n => only === undefined || n === only).map(n => loadTask(join(tasksDir, n))));
}

export function runPython(workspace: string, args: string[], opts: RunPythonOptions): Promise<RunPythonResult> {
  return new Promise(res => {
    const child = spawn('python3', ['-u', ...args], { cwd: workspace, env: sanitizedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs);
    const write = (text: string): void => { if (!child.stdin.destroyed) child.stdin.write(text); };
    child.stdin.on('error', () => {});
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    if (opts.onLine) createInterface({ input: child.stdout }).on('line', line => opts.onLine!(line, write));
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    opts.onStart?.(write);
    child.on('error', err => { clearTimeout(timer); res({ code: null, stdout, stderr: stderr + String(err), timedOut }); });
    child.on('close', code => { clearTimeout(timer); res({ code, stdout, stderr, timedOut }); });
  });
}

async function commit(): Promise<string | null> {
  try { return (await promisify(execFile)('git', ['rev-parse', 'HEAD'])).stdout.trim(); }
  catch { return null; }
}

export interface RunEvalOptions {
  provider: DecisionProvider;
  out: string;
  tasksDir?: string;
  only?: string;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
  onRecord?: (record: EvalRecord) => void;
}

export async function runEval(opts: RunEvalOptions): Promise<EvalRecord[]> {
  const tasks = await loadTasks(opts.tasksDir ?? defaultTasksDir, opts.only);
  const sha = await commit();
  const records: EvalRecord[] = [];
  for (const task of tasks) {
    const ws = await mkdtemp(join(tmpdir(), `jev-eval-${task.name}-`));
    try {
      const harness = new Harness({
        workspace: ws, provider: opts.provider, tools: builtInTools(), journalDirectory: join(resolve(opts.out), '.jev', 'eval', 'journals', task.name),
        maxTurns: task.limits.maxTurns ?? DEFAULT_LIMITS.maxTurns, maxRequests: task.limits.maxRequests ?? DEFAULT_LIMITS.maxRequests,
        maxGenerationSteps: task.limits.maxGenerationSteps ?? DEFAULT_LIMITS.maxGenerationSteps, maxRunMs: task.limits.maxRunMs ?? DEFAULT_LIMITS.maxRunMs,
        authorize: () => true, ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      });
      const result = await harness.run(task.prompt);
      const check = result.status === 'completed' ? await task.check(ws) : { ok: false, reason: `run ${result.status}: ${result.summary}` };
      const record: EvalRecord = {
        task: task.name, stage: task.stage, status: result.status, summary: result.summary, check,
        turns: result.turns, requests: result.requests, inputTokens: result.usage.inputTokens, durationMs: result.durationMs,
        runId: result.id, commit: sha, startedAt: result.startedAt,
      };
      records.push(record);
      opts.onRecord?.(record);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  }
  const dir = join(resolve(opts.out), '.jev', 'eval');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
  return records;
}

export interface CompareRow { task: string; a?: EvalRecord; b?: EvalRecord; deltas?: { requests: number; durationMs: number } }

export function compareRecords(a: EvalRecord[], b: EvalRecord[]): CompareRow[] {
  const byTask = (records: EvalRecord[]): Map<string, EvalRecord> => new Map(records.map(r => [r.task, r]));
  const left = byTask(a), right = byTask(b);
  return [...new Set([...left.keys(), ...right.keys()])].sort().map(task => {
    const x = left.get(task), y = right.get(task);
    return { task, ...(x ? { a: x } : {}), ...(y ? { b: y } : {}),
      ...(x && y ? { deltas: { requests: y.requests - x.requests, durationMs: y.durationMs - x.durationMs } } : {}) };
  });
}

export function formatComparison(rows: CompareRow[]): string {
  const sign = (n: number, fmt: (v: number) => string): string => `${n < 0 ? '-' : '+'}${fmt(Math.abs(n))}`;
  const cell = (row: CompareRow, f: (r: EvalRecord) => string): string => `${row.a ? f(row.a) : 'absent'} → ${row.b ? f(row.b) : 'absent'}`;
  const lines = ['| task | pass | requests | duration | status |', '| --- | --- | --- | --- | --- |'];
  for (const row of rows) {
    const d = row.deltas;
    lines.push(`| ${row.task} | ${cell(row, r => r.check.ok ? 'pass' : 'fail')} | ${cell(row, r => String(r.requests))}${d ? ` (${sign(d.requests, String)})` : ''} | ${cell(row, r => formatDuration(r.durationMs))}${d ? ` (${sign(d.durationMs, formatDuration)})` : ''} | ${cell(row, r => r.status)} |`);
  }
  return lines.join('\n') + '\n';
}
