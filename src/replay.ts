import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createPrinter } from './print.js';
import { attemptScope, type DecisionSeed } from './run-context.js';
import type { HarnessEvent, Tool, ToolRecord } from './types.js';

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

export type ToolEffect = Tool['effect'];

/** A resume plan built from an interrupted run's journal; the new run gets its own journal id. */
export interface ResumePlan {
  /** Journaled run id this resume continues. */
  from: string;
  /** Original task prompt, taken from the journal's start event. */
  prompt: string;
  /** Workspace the journal was written in (its stored realpath). */
  workspace: string;
  /** First turn the resumed run executes: max(turn_end) + 1. */
  turn: number;
  /** Turns carried over, recorded on the new start event and rendered by the transcript. */
  turns: number;
  /** Request usage carried over; seeds the run budget and the transcript counter. */
  requests: number;
  /** Tool records rebuilt from tool_end events, with their original turn numbers. */
  records: ToolRecord[];
  /** Most recent journaled plan text, for model continuity. */
  plan: string;
  /** Decision ids and retained alternatives rebuilt from journaled decision events. */
  decisions: DecisionSeed[];
  /** Non-fatal notes (truncation, unknown outcomes) for the caller to surface. */
  warnings: string[];
}

export interface ResumableJournal {
  /** Every complete event in the file; a torn final line is dropped. */
  all: HarnessEvent[];
  /** The resumable prefix: events through the last complete turn_end. */
  events: HarnessEvent[];
  /** Number of events dropped after the last complete turn_end. */
  truncated: number;
  /** True when the file's final line was an incomplete write and was dropped. */
  torn: boolean;
}

/**
 * Read a journal for resume: tolerate one torn final line, then truncate at the last complete
 * turn_end (an incomplete turn is re-run from its start). When no turn completed, only the events
 * before the first turn are kept. A parse failure anywhere but the final line is corruption.
 */
export async function readResumableJournal(path: string): Promise<ResumableJournal> {
  const lines = (await readFile(path, 'utf8')).split('\n');
  const all: HarnessEvent[] = [];
  let torn = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line) as HarnessEvent);
    } catch (error) {
      if (lines.slice(index + 1).some(next => next.trim())) throw error;
      torn = true;
      break;
    }
  }
  let lastTurnEnd = -1;
  for (let index = 0; index < all.length; index++) if (all[index]!.type === 'turn_end') lastTurnEnd = index;
  const firstTurn = all.findIndex(event => event.type === 'turn');
  const cut = lastTurnEnd >= 0 ? lastTurnEnd + 1 : firstTurn < 0 ? all.length : Math.max(1, firstTurn);
  return { all, events: all.slice(0, cut), truncated: all.length - cut, torn };
}

/** Newest journal in <cwd>/.jev/runs by mtime; `last` resolves through this. */
export async function findLatestJournal(cwd: string): Promise<string | undefined> {
  const directory = join(cwd, '.jev', 'runs');
  const names = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'));
  let best: { path: string; mtimeMs: number; name: string } | undefined;
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    if (best === undefined || info.mtimeMs > best.mtimeMs || (info.mtimeMs === best.mtimeMs && name > best.name)) {
      best = { path, mtimeMs: info.mtimeMs, name };
    }
  }
  return best?.path;
}

export interface ResumeOptions {
  /** Journal path (a .jsonl file, already resolved from a run id). */
  journalPath: string;
  /** Requested workspace; its realpath must match the journal's stored start workspace. */
  workspace: string;
  /** Effect lookup for tools seen in unmatched tool_start events; unknown tools are refused. */
  effectOf: (tool: string) => ToolEffect | undefined;
}

/**
 * Validate an interrupted run's journal and build the resume plan: eligibility is "no completed
 * end event", the workspace realpath must match, the read truncates at the last complete turn_end,
 * and the partial-effect policy refuses an unmatched shell tool start while recording an unknown
 * outcome for read/write starts. Eval journals are refused: their workspaces are temporary.
 */
export async function prepareResume(options: ResumeOptions): Promise<ResumePlan> {
  const journalPath = resolve(options.journalPath);
  if (journalPath.includes(`${sep}.jev${sep}eval${sep}journals${sep}`)) {
    throw new Error(`Journal ${journalPath} belongs to an eval run, whose workspace is a temporary directory; eval journals cannot be resumed.`);
  }
  const read = await readResumableJournal(journalPath);
  const start = read.events[0];
  if (!start || start.type !== 'start') throw new Error(`Journal ${journalPath} does not begin with a start event.`);
  const from = start.runId;
  const schema: number = start.data.schema ?? 0;
  if (schema > SCHEMA) throw new Error(`Journal schema ${schema} is newer than the supported schema ${SCHEMA}; this journal cannot be resumed.`);
  if (read.all.some(event => event.type === 'end' && event.data.status === 'completed')) {
    throw new Error(`Run ${from} already completed; there is nothing to resume.`);
  }
  const requested = await realpath(options.workspace).catch(() => undefined);
  if (requested === undefined) throw new Error(`Workspace ${options.workspace} does not exist.`);
  if (start.data.workspace !== requested) {
    throw new Error(`Run ${from} belongs to workspace ${start.data.workspace}; pass --workspace ${start.data.workspace} to resume it.`);
  }

  const warnings: string[] = [];
  if (read.torn) warnings.push("the journal's final line was incomplete and was ignored");
  if (read.truncated > 0) warnings.push(`ignored ${read.truncated} journal event${read.truncated === 1 ? '' : 's'} after the last complete turn_end`);

  // Pair tool_start/tool_end sequentially; anything still pending has no journaled outcome.
  const pending: Array<{ index: number; event: Extract<HarnessEvent, { type: 'tool_start' }> }> = [];
  for (let index = 0; index < read.events.length; index++) {
    const event = read.events[index]!;
    if (event.type === 'tool_start') pending.push({ index, event });
    else if (event.type === 'tool_end') pending.pop();
  }
  const unmatched = new Map(pending.map(entry => [entry.index, entry.event]));

  const records: ToolRecord[] = [];
  const decisions: DecisionSeed[] = [];
  let plan = '';
  let requests = 0;
  for (let index = 0; index < read.events.length; index++) {
    const event = read.events[index]!;
    switch (event.type) {
      case 'turn': plan = event.data.plan; break;
      case 'turn_end': requests += event.data.requests; break;
      case 'tool_end': records.push(event.data); break;
      case 'tool_start': {
        if (!unmatched.has(index)) break;
        const effect = options.effectOf(event.data.tool);
        if (effect === undefined || effect === 'shell') {
          throw new Error(`Run ${from} was interrupted while ${event.data.tool} ${JSON.stringify(event.data.args)} was in flight; its effect cannot be verified, so resume refuses to continue. Run the command again to confirm its outcome.`);
        }
        warnings.push(`the ${event.data.tool} call at turn ${event.turn} has no journaled result; its outcome is recorded as unknown and is not replayed`);
        records.push({ turn: event.turn, tool: event.data.tool, args: event.data.args,
          result: { ok: false, output: 'Unknown outcome: the run was interrupted while this tool call was in flight; resume did not replay it.' } });
        break;
      }
      case 'decision': {
        const { decisionId, choice, options: alternatives, field, phase, slot, unit, candidate, nearTie } = event.data;
        if (decisionId === undefined || choice === undefined || alternatives === undefined || field === undefined) break;
        decisions.push({
          decisionId, scope: attemptScope(field, unit, candidate), questionKey: slot ?? field,
          identity: { field, ...(phase === undefined ? {} : { phase }), ...(slot === undefined ? {} : { slot }), ...(unit === undefined ? {} : { unit }), ...(candidate === undefined ? {} : { candidate }) },
          chosen: choice, alternatives, nearTie: nearTie ?? false,
        });
        break;
      }
      default: break;
    }
  }

  let lastTurnEnd = -1;
  for (let index = 0; index < read.events.length; index++) if (read.events[index]!.type === 'turn_end') lastTurnEnd = index;
  const turn = lastTurnEnd >= 0 ? read.events[lastTurnEnd]!.turn + 1 : 1;
  return { from, prompt: start.data.prompt, workspace: start.data.workspace, turn, turns: turn - 1, requests, records, plan, decisions, warnings };
}
