import { diffLines, type DiffLine } from './diff.js';
import { formatSearchOutcome } from './grid.js';
import { runSummary, type RunSummary } from './summary.js';
import type { DecisionOption, HarnessEvent, ToolRecord } from './types.js';

export type SessionEvent =
  | { type: 'permission'; data: { tool: string; args: ToolRecord['args'] } }
  | { type: 'permission_result'; data: { tool: string; allowed: boolean } }
  | { type: 'host_command'; data: { command: string } };

export type ToolStatus = 'pending' | 'awaiting' | 'generating' | 'running' | 'done' | 'failed' | 'denied';
export type Body =
  | { kind: 'source'; path: string; lines: string[]; remaining: number; hint: string }
  | { kind: 'diff'; path: string; hunk: DiffLine[] }
  | { kind: 'output'; lines: string[]; remaining: number }
  | { kind: 'paths'; paths: string[]; remaining: number };

export interface ToolItem {
  kind: 'tool'; turn: number; status: ToolStatus; tool: string; target: string;
  body?: Body; startedMs: number; durationMs?: number; requests: number; exitCode?: number; host?: true;
}
export interface Decision {
  turn: number; choice: string; confidence?: number; options: DecisionOption[]; lowConfidence: boolean;
  field?: string; slot?: string; unit?: string; candidate?: number;
}
export type Item =
  | { kind: 'prompt'; text: string }
  | ToolItem
  | { kind: 'turn'; turn: number; files: number; plan: string }
  | { kind: 'update'; text: string }
  | { kind: 'trace'; decisions: Decision[] }
  | (RunSummary & { kind: 'summary'; runId: string; turns: number; requests: number; limits?: { turns: number; requests: number }; usage: { inputTokens: number; outputTokens: number }; durationMs: number });

export interface Live {
  card: ToolItem; path?: string; field?: string; source?: string; slot?: string; production?: string; unit?: string; candidate?: number;
  decision?: Decision; latest: Record<string, Decision>; output: string; search?: string; grid?: { round: number; columns: number; cells: Array<string | null>; completed: number; total: number };
}
export interface TranscriptState {
  schema?: number; items: Item[]; live?: Live; decisions: Decision[]; requests: number; files: string[]; turn: number; elapsedMs: number;
  limits?: { turns: number; requests: number }; records: ToolRecord[];
}

export const RING = 20;
const SOURCE_LINES = 8, OUTPUT_LINES = 6, PATH_LINES = 8, COMMAND_LINES = 40;
export { OUTPUT_LINES };

export const initialState = (): TranscriptState => ({ items: [], decisions: [], requests: 0, files: [], turn: 0, elapsedMs: 0, records: [] });

const lines = (text: string): string[] => text === '' ? [] : text.replace(/\n$/, '').split('\n');
const clip = <T>(all: T[], max: number): { head: T[]; remaining: number } => ({ head: all.slice(0, max), remaining: Math.max(0, all.length - max) });
const key = (d: { field?: string; unit?: string; candidate?: number }): string => `${d.field ?? ''}|${d.unit ?? ''}|${d.candidate ?? ''}`;
const str = (val: unknown): string => typeof val === 'string' ? val : '';
const pendingBody = (b: Body): Body => b.kind === 'source' ? { ...b, hint: 'written after approval' } : b;
const gridSource = (cells: Array<string | null>, columns: number): string => {
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += columns) rows.push(cells.slice(i, i + columns).map(c => c ?? '·').join(''));
  return rows.join('\n');
};

const target = (tool: string, args: ToolRecord['args'], data?: Record<string, unknown>): string => {
  if (tool === 'bash') return str(args.command);
  if (tool === 'write_files') return Array.isArray(data?.paths) ? `${data.paths.length} files` : '';
  if (tool === 'set_plan') return 'plan';
  return str(args.path);
};

const body = (record: ToolRecord, streamed: string): Body => {
  const { tool, args, result } = record;
  if (result.ok && tool === 'write_file') {
    const { head, remaining } = clip(lines(str(args.content)), SOURCE_LINES);
    return { kind: 'source', path: str(args.path), lines: head, remaining, hint: `/show ${str(args.path)}` };
  }
  if (result.ok && tool === 'edit_file') return { kind: 'diff', path: str(args.path), hunk: diffLines(str(args.old_text), str(args.new_text)) };
  if (result.ok && tool === 'write_files') {
    const { head, remaining } = clip(Array.isArray(result.data?.paths) ? result.data.paths as string[] : [], PATH_LINES);
    return { kind: 'paths', paths: head, remaining };
  }
  const { head, remaining } = clip(lines(tool === 'bash' && streamed ? streamed : result.output), OUTPUT_LINES);
  return { kind: 'output', lines: head, remaining };
};

const writtenPaths = (record: ToolRecord): string[] => {
  if (!record.result.ok) return [];
  if (['write_file', 'edit_file'].includes(record.tool) && typeof record.args.path === 'string') return [record.args.path];
  if (record.tool === 'write_files' && Array.isArray(record.result.data?.paths)) return record.result.data.paths as string[];
  return [];
};

const lowConfidence = (options: DecisionOption[], confidence: number | undefined): boolean =>
  (confidence !== undefined && confidence < 0.5) || (options.length > 1 && options[0]!.probability - options[1]!.probability < 0.1);

const card = (turn: number, tool: string, startedMs: number, args: ToolRecord['args'] = {}, status: ToolStatus = 'pending'): ToolItem =>
  ({ kind: 'tool', turn, status, tool, target: target(tool, args), startedMs, requests: 0 });

const live = (state: TranscriptState, card: ToolItem): Live => ({ card, latest: {}, output: '', ...(state.live ? { latest: state.live.latest } : {}) });

const finish = (state: TranscriptState, record: ToolRecord, elapsedMs: number): TranscriptState => {
  const cur = state.live?.card ?? card(record.turn, record.tool, elapsedMs, record.args);
  const denied = cur.status === 'denied' || (!record.result.ok && record.result.output.startsWith('Host declined'));
  const exitCode = typeof record.result.data?.exitCode === 'number' ? record.result.data.exitCode : undefined;
  const done: ToolItem = {
    ...cur, status: denied ? 'denied' : record.result.ok ? 'done' : 'failed', target: target(record.tool, record.args, record.result.data),
    body: body(record, state.live?.output ?? ''), durationMs: Math.max(0, elapsedMs - cur.startedMs), ...(exitCode === undefined ? {} : { exitCode }),
  };
  const { live: _live, ...rest } = state;
  const files = [...state.files];
  for (const path of writtenPaths(record)) if (!files.includes(path)) files.push(path);
  return { ...rest, items: [...state.items, done], files, records: cur.host ? state.records : [...state.records, record] };
};

export function reduce(state: TranscriptState, event: HarnessEvent | SessionEvent): TranscriptState {
  if (!('runId' in event)) return reduceSession(state, event);
  const at = event.elapsedMs;
  state = { ...state, turn: event.turn, elapsedMs: at };
  switch (event.type) {
    case 'start': return { ...state, schema: event.data.schema ?? 0, limits: event.data.limits, items: [...state.items, { kind: 'prompt', text: event.data.prompt }] };
    case 'turn': return { ...state, items: [...state.items, { kind: 'turn', turn: event.turn, files: event.data.files, plan: event.data.plan }] };
    case 'turn_end': return state;
    case 'input': return { ...state, items: [...state.items, { kind: 'update', text: event.data.instruction }] };
    case 'action': return { ...state, live: live(state, card(event.turn, event.data.tool, at)) };
    case 'decision': {
      const requests = state.requests + 1;
      const cur = state.live;
      if (event.data.choice === undefined) return { ...state, requests, ...(cur ? { live: { ...cur, card: { ...cur.card, requests: cur.card.requests + 1 } } } : {}) };
      const { choice, confidence, options = [], field, slot, unit, candidate } = event.data;
      const d: Decision = { turn: event.turn, choice, options, lowConfidence: lowConfidence(options, confidence),
        ...(confidence === undefined ? {} : { confidence }), ...(field === undefined ? {} : { field }),
        ...(slot === undefined ? {} : { slot }), ...(unit === undefined ? {} : { unit }), ...(candidate === undefined ? {} : { candidate }) };
      const decisions = [...state.decisions, d].slice(-RING);
      if (!cur) return { ...state, requests, decisions };
      const mine = cur.decision === undefined || key(d) === key(cur);
      return { ...state, requests, decisions, live: { ...cur, card: { ...cur.card, requests: cur.card.requests + 1 }, latest: { ...cur.latest, [key(d)]: d }, ...(mine ? { decision: d } : {}) } };
    }
    case 'text': {
      const { field, change, decoder, ast } = event.data;
      const cur = state.live ?? live(state, card(event.turn, 'text', at));
      const next: Live = { ...cur, field, card: cur.card.status === 'pending' ? { ...cur.card, status: 'generating' } : cur.card };
      if (decoder === 'search' && ast) return { ...state, live: { ...next, search: formatSearchOutcome(field, ast) } };
      if (change && 'replace' in change) {
        if (field === 'path') next.path = change.replace;
        else next.source = change.replace;
      }
      if (change && 'grid' in change) {
        const { round, columns, completed, total, cells: filled } = change.grid;
        const cells = cur.grid?.round === round ? [...cur.grid.cells] : Array<string | null>(total).fill(null);
        for (const cell of filled) cells[cell.index] = cell.value;
        next.grid = { round, columns, cells, completed, total };
        next.source = gridSource(cells, columns);
      }
      if (ast) {
        next.slot = ast.slot; next.production = ast.production;
        if (ast.unit === undefined) delete next.unit; else next.unit = ast.unit;
        if (ast.candidate === undefined) delete next.candidate; else next.candidate = ast.candidate;
        const paired = cur.latest[key({ field, ...(ast.unit === undefined ? {} : { unit: ast.unit }), ...(ast.candidate === undefined ? {} : { candidate: ast.candidate }) })];
        next.decision = paired?.slot === ast.slot ? paired
          : { turn: event.turn, choice: ast.production, options: [], lowConfidence: false, field, slot: ast.slot, ...(ast.unit === undefined ? {} : { unit: ast.unit }), ...(ast.candidate === undefined ? {} : { candidate: ast.candidate }) };
      }
      return { ...state, live: next };
    }
    case 'tool_start': {
      const cur = state.live ?? live(state, card(event.turn, event.data.tool, at));
      return { ...state, live: { ...cur, card: { ...cur.card, status: 'running', target: target(event.data.tool, event.data.args), startedMs: at } } };
    }
    case 'tool_output': return state.live ? { ...state, live: { ...state.live, output: state.live.output + event.data.text } } : state;
    case 'tool_end': return finish(state, event.data, at);
    case 'end': {
      const { status, summary, turns, requests, usage, durationMs } = event.data;
      const { live: _live, ...rest } = state;
      const item: Item = { kind: 'summary', runId: event.runId, ...runSummary(status, summary, state.records), turns, requests, usage, durationMs, ...(state.limits ? { limits: state.limits } : {}) };
      return { ...rest, items: [...state.items, item] };
    }
    default: return state;
  }
}

function reduceSession(state: TranscriptState, event: SessionEvent): TranscriptState {
  switch (event.type) {
    case 'permission': {
      const { tool, args } = event.data;
      const cur = state.live ?? live(state, card(state.turn, tool, state.elapsedMs));
      const command = lines(str(args.command));
      const preview = ['write_file', 'edit_file'].includes(tool) ? { body: pendingBody(body({ turn: state.turn, tool, args, result: { ok: true, output: '' } }, '')) }
        : tool === 'bash' && command.length > 1 ? { body: { kind: 'output' as const, ...(({ head, remaining }) => ({ lines: head, remaining }))(clip(command, COMMAND_LINES)) } } : {};
      const shown = tool === 'bash' && command.length > 1 ? `${command[0]} …` : target(tool, args);
      return { ...state, live: { ...cur, card: { ...cur.card, status: 'awaiting', target: shown, ...preview } } };
    }
    case 'permission_result':
      return state.live ? { ...state, live: { ...state.live, card: { ...state.live.card, status: event.data.allowed ? 'running' : 'denied' } } } : state;
    case 'host_command':
      return { ...state, live: live(state, { ...card(state.turn, 'bash', state.elapsedMs, { command: event.data.command }, 'running'), host: true }) };
  }
}

export const traceItem = (state: TranscriptState, n = RING): TranscriptState => ({ ...state, items: [...state.items, { kind: 'trace', decisions: state.decisions.slice(-n) }] });

export const pct = (val: number): string => `${Math.round(val * 100)}%`;
export const decisionHead = (d: Decision): string[] =>
  [`${d.slot ?? d.field ?? 'action'} → ${d.choice}`, d.options[0] ? pct(d.options[0].probability) : '', d.lowConfidence ? 'low confidence' : ''].filter(Boolean);
export function decisionStrip(state: TranscriptState): string {
  const d = state.live?.decision;
  const grid = state.live?.grid;
  if (grid && !d) return `grid · round ${grid.round} · ${grid.completed}/${grid.total} cells · ${state.requests} req`;
  if (!d) return 'choosing…';
  return [...decisionHead(d), `${state.requests} req`].join(' · ');
}
export const livePhase = (live: Live): string =>
  live.card.status === 'generating' ? `generating ${live.field ?? ''}`.trim() : live.card.status === 'running' ? `running ${live.card.tool}` : 'deciding';
