import { access, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPrinter } from './print.js';
import type { HarnessEvent } from './types.js';

export const SCHEMA = 1;
export const MAX_GAP_MS = 2000;

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

export async function findJournal(cwd: string, runId: string): Promise<string | undefined> {
  if (runId.endsWith('.jsonl')) { const path = resolve(cwd, runId); return await exists(path) ? path : undefined; }
  const direct = join(cwd, '.jev', 'runs', `${runId}.jsonl`);
  if (await exists(direct)) return direct;
  const root = join(cwd, '.jev', 'eval', 'journals');
  for (const task of await readdir(root).catch(() => [] as string[])) {
    const path = join(root, task, `${runId}.jsonl`);
    if (await exists(path)) return path;
  }
  return undefined;
}

export async function readJournal(path: string): Promise<HarnessEvent[]> {
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as HarnessEvent);
}

export function checkSchema(events: HarnessEvent[]): string | undefined {
  const first = events[0];
  if (!first || first.type !== 'start') throw new Error('Journal does not begin with a start event.');
  const schema: number = first.data.schema ?? 0;
  if (schema > SCHEMA) throw new Error(`Journal schema ${schema} is newer than the supported schema ${SCHEMA}.`);
  return schema < SCHEMA ? `journal schema ${schema} predates schema ${SCHEMA}; replaying best-effort.` : undefined;
}

export const gapMs = (prev: HarnessEvent, cur: HarnessEvent, speed: number): number =>
  speed > 0 ? Math.min(MAX_GAP_MS, Math.max(0, (cur.elapsedMs - prev.elapsedMs) / speed)) : 0;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise(done => {
  const finish = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', finish); done(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener('abort', finish, { once: true });
});

export async function drive(events: HarnessEvent[], speed: number, emit: (event: HarnessEvent) => void, signal?: AbortSignal): Promise<void> {
  let prev: HarnessEvent | undefined;
  for (const event of events) {
    const wait = prev ? gapMs(prev, event, speed) : 0;
    if (wait > 0) await sleep(wait, signal);
    if (signal?.aborted) return;
    emit(event);
    prev = event;
  }
}

type Out = NodeJS.WritableStream & { isTTY?: boolean };

export async function replayPlain(events: HarnessEvent[], streams: { stdout: Out; stderr: Out }, speed = 0, signal?: AbortSignal): Promise<void> {
  const printer = createPrinter(streams.stderr);
  await drive(events, speed, printer.onEvent, signal);
  if (signal?.aborted) return;
  const summary = printer.summary();
  if (summary.length) streams.stdout.write(summary.join('\n') + '\n');
}
