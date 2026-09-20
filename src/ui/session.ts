import { open } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { DEFAULT_LIMITS, Harness, type HarnessOptions } from '../harness.js';
import { highlightCode, isInteractiveTTY, terminalColor } from '../terminal-style.js';
import { formatDuration } from '../timing.js';
import { autoApproved, runBash } from '../tools.js';
import { initialState, livePhase, reduce, traceItem, type Item, type SessionEvent, type TranscriptState } from '../transcript.js';
import type { HarnessEvent, RunResult, RunStatus, Tool, ToolRecord } from '../types.js';
import { resolveWorkspacePath } from '../workspace.js';

export const COMMANDS = ['/help', '/status', '/plan', '/history', '/files', '/show', '/clear', '/cancel', '/permissions', '/paste', '/exit', '/trace'];
const HELP = `Type a task or a follow-up. During a run, new text updates the task at the next turn.
  /help                  Show these commands
  /status                Show current activity and the last run
  /plan                  Show the latest plan
  /history               Show recent tasks and their outcomes
  /files                 List files written or edited in this session
  /show <path>           View a file with line numbers without a model request
  /trace [n]             List the last n decisions with their alternatives
  /clear                 Start a fresh conversation (keeps files and journals)
  /cancel                Cancel the current run and stay in the session
  /permissions ask|auto  Confirm agent shell commands, or allow them automatically
  /paste                 Enter a multiline task; /end submits, /abort discards
  /exit                  Cancel current work and exit
  !<bash command>        Run your command directly and share its result with Jev
Ctrl-C cancels current work; at an empty idle prompt it exits. Tab completes commands.`;

export const TRACE_DEFAULT = 10, TRACE_MAX = 20;
export const APPROVAL_KEYS = 'y allow · n deny · a always';
export const APPROVAL_DRAFT = 'send or erase your line, then y allow · n deny · a always';
export const APPROVAL_GRACE_MS = 300;

export interface SessionOptions {
  harness: Omit<HarnessOptions, 'onEvent' | 'authorize'>;
  model: string;
  initialPrompt?: string;
  yes?: boolean;
  confirmWrites?: boolean;
  approvalGraceMs?: number;
  tty?: boolean;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
}

export type Tone = 0 | 32 | 33;
export type Row = { id: number; item: Item } | { id: number; note: string; tone: Tone };
export interface Snapshot {
  rows: Row[]; state: TranscriptState; color: boolean; running: boolean; started?: number; paste: boolean;
  mode: 'ask' | 'auto'; closing: boolean; requestLimit: number; awaiting: boolean;
}
export interface Session {
  snapshot(): Snapshot;
  subscribe(fn: () => void): () => void;
  submit(line: string): void;
  answer(key: 'y' | 'n' | 'a'): void;
  interrupt(hasText: boolean): boolean;
  complete(line: string): string[];
  onEvent(event: HarnessEvent): void;
  close(code: number): void;
  readonly closed: Promise<number>;
}

type Entry = { prompt: string; status: RunStatus | 'working'; durationMs?: number };
const msg = (err: unknown): string => err instanceof Error ? err.message : String(err);

export function createSession(opts: SessionOptions): Session {
  const color = terminalColor(opts.tty ?? isInteractiveTTY(process.stdin, process.stderr));
  const { workspace } = opts.harness;
  const listeners = new Set<() => void>();
  const history: Entry[] = [];
  let state = initialState(), rows: Row[] = [], printed = 0, nextId = 0;
  let mode: 'ask' | 'auto' = opts.yes ? 'auto' : 'ask';
  let model = opts.model, plan = '', closing = false;
  let active: { controller: AbortController; kind: 'agent' | 'shell'; started: number } | undefined;
  let paste: string[] | undefined;
  let pending: { tool: string; settle: (allowed: boolean) => void; since: number } | undefined;
  const grace = opts.approvalGraceMs ?? APPROVAL_GRACE_MS;
  const allowed = new Set<string>();
  let lastRun: RunResult | undefined;
  let work: Promise<void> | undefined;
  let snap: Snapshot | undefined;
  let timer: NodeJS.Timeout | undefined;
  let resolveClosed!: (code: number) => void;
  const closed = new Promise<number>(resolve => { resolveClosed = resolve; });

  const notify = (): void => { snap = undefined; for (const fn of listeners) fn(); };
  const flush = (): void => { if (timer) { clearTimeout(timer); timer = undefined; } notify(); };
  const later = (): void => { if (!timer) timer = setTimeout(flush, 50); };
  const sync = (): void => { for (const item of state.items.slice(printed)) rows = [...rows, { id: nextId++, item }]; printed = state.items.length; };
  const apply = (event: HarnessEvent | SessionEvent): void => { state = reduce(state, event); sync(); };
  const note = (text: string, tone: Tone = 0): void => { rows = [...rows, { id: nextId++, note: text, tone }]; notify(); };

  const onEvent = (event: HarnessEvent): void => {
    apply(event);
    if (event.type === 'decision') model = event.data.model;
    if (event.type === 'tool_end' && typeof event.data.result.data?.plan === 'string') plan = event.data.result.data.plan;
    if (event.type === 'text') later(); else flush();
  };
  const authorize = (tool: Tool, args: ToolRecord['args'], signal: AbortSignal): boolean | Promise<boolean> => {
    if (mode === 'auto' || allowed.has(tool.name) || autoApproved(tool, opts.confirmWrites)) return true;
    signal.throwIfAborted();
    return new Promise(resolve => {
      const settle = (ok: boolean): void => {
        pending = undefined;
        signal.removeEventListener('abort', deny);
        apply({ type: 'permission_result', data: { tool: tool.name, allowed: ok } });
        flush();
        resolve(ok);
      };
      const deny = (): void => settle(false);
      pending = { tool: tool.name, settle, since: performance.now() };
      signal.addEventListener('abort', deny, { once: true });
      apply({ type: 'permission', data: { tool: tool.name, args } });
      flush();
    });
  };
  const answer = (key: 'y' | 'n' | 'a'): void => {
    if (!pending || performance.now() - pending.since < grace) return;
    if (key === 'a') allowed.add(pending.tool);
    pending.settle(key !== 'n');
  };
  const harness = new Harness({ ...opts.harness, onEvent: async event => { onEvent(event); await opts.onEvent?.(event); }, authorize });

  const shell = async (command: string, signal: AbortSignal): Promise<Entry['status']> => {
    apply({ type: 'host_command', data: { command } });
    flush();
    const base = state.elapsedMs, t0 = performance.now();
    const meta = () => ({ runId: 'host', timestamp: new Date().toISOString(), elapsedMs: base + Math.round(performance.now() - t0), turn: state.turn });
    const result = await runBash(command, workspace, 600_000, signal, 32_000, async (stream, text) => { apply({ ...meta(), type: 'tool_output', data: { stream, text } }); later(); });
    const record: ToolRecord = { turn: 0, tool: 'bash', args: { command, cwd: workspace }, result };
    apply({ ...meta(), type: 'tool_end', data: record });
    flush();
    harness.observe(record);
    return result.data?.cancelled ? 'cancelled' : result.ok ? 'completed' : 'error';
  };

  const execute = async (prompt: string, kind: 'agent' | 'shell'): Promise<void> => {
    const entry: Entry = { prompt, status: 'working' };
    history.push(entry);
    if (history.length > 20) history.shift();
    const controller = new AbortController();
    active = { controller, kind, started: performance.now() };
    state = { ...initialState(), files: state.files };
    printed = 0;
    notify();
    try {
      if (kind === 'shell') entry.status = await shell(prompt, controller.signal);
      else {
        const result = await harness.run(prompt, controller.signal);
        lastRun = result;
        entry.status = result.status;
        entry.durationMs = result.durationMs;
      }
    } catch (err) {
      entry.status = controller.signal.aborted ? 'cancelled' : 'error';
      note(`${entry.status}: ${msg(err)}`, 33);
    } finally {
      entry.durationMs ??= Math.round(performance.now() - active.started);
      active = undefined;
      flush();
    }
  };

  const show = async (path: string): Promise<void> => {
    if (!path) throw new Error('Use /show <path>.');
    const file = await open(await resolveWorkspacePath(workspace, path, opts.harness.allowOutsideWorkspace ?? false), 'r');
    try {
      const buf = Buffer.alloc(64_001);
      const { bytesRead } = await file.read(buf, 0, buf.length, 0);
      const lines = stripVTControlCharacters(buf.subarray(0, Math.min(bytesRead, 64_000)).toString('utf8')).replace(/\r/g, '').split('\n');
      const foot = bytesRead > 64_000 || lines.length > 300 ? 'Preview truncated at 64 KB / 300 lines' : `${bytesRead} B`;
      note(`╭─ ${path}\n${lines.slice(0, 300).map((line, i) => `│ ${String(i + 1).padStart(3)}  ${highlightCode(line, color)}`).join('\n')}\n╰─ ${foot}`);
    } finally { await file.close(); }
  };

  const cancel = (): void => {
    if (!active) return note('No run is active.', 33);
    active.controller.abort(new Error('Cancelled by user.'));
  };

  const close = (code: number): void => {
    if (closing) return;
    closing = true;
    active?.controller.abort(new Error('Session closed.'));
    notify();
    void Promise.resolve(work).then(() => resolveClosed(code));
  };

  const permissions = (): string => `Permissions: ${mode}${allowed.size ? ` · always: ${[...allowed].join(', ')}` : ''}`;
  const phase = (): string => {
    const live = state.live;
    if (!active) return 'ready';
    if (!live) return active.kind === 'shell' ? 'bash' : 'deciding';
    return livePhase(live);
  };

  const command = (text: string): void => {
    const [cmd = '', ...args] = text.split(/\s+/);
    switch (cmd) {
      case '/help': return note(HELP);
      case '/exit': return close(0);
      case '/cancel': return cancel();
      case '/status': return note([`Workspace: ${workspace}`, `Model: ${model}`, permissions(),
        `Activity: ${phase()}${active ? ` · ${formatDuration(performance.now() - active.started)} elapsed` : ''}`,
        `Current turn: ${state.turn} · ${state.requests} decisions answered`,
        ...(lastRun ? [`Last run: ${lastRun.status} · ${formatDuration(lastRun.durationMs)} · ${lastRun.id}`] : [])].join('\n'));
      case '/plan': return note(plan || 'No plan recorded yet.');
      case '/history': return note(history.map((e, i) => `${i + 1}. [${e.status}] ${e.prompt.replace(/\n/g, ' ').slice(0, 200)}${e.durationMs === undefined ? '' : ` · ${formatDuration(e.durationMs)}`}`).join('\n') || 'No tasks yet.');
      case '/files': return note(state.files.map(path => `  ${path}`).join('\n') || 'No files generated in this session yet.');
      case '/show': void show(text.slice(cmd.length).trim()).catch(err => note(`Error: ${msg(err)}`, 33)); return;
      case '/clear':
        if (active) return note('Use /cancel and wait for it to stop before /clear.', 33);
        harness.reset(); history.length = 0; plan = ''; lastRun = undefined; allowed.clear();
        return note('Fresh conversation. Files and journals kept.');
      case '/permissions':
        if (args.length === 0) return note(`${permissions()}. Use /permissions ask or /permissions auto.`);
        if (args.length !== 1 || (args[0] !== 'ask' && args[0] !== 'auto')) return note('Use /permissions ask or /permissions auto.', 33);
        mode = args[0];
        if (mode === 'ask') allowed.clear();
        return note(`${permissions()}.`);
      case '/paste': paste = []; return note('Paste a multiline task. /end submits; /abort discards.');
      case '/trace': {
        const n = args[0] === undefined ? TRACE_DEFAULT : Number(args[0]);
        if (!Number.isInteger(n) || n < 1) return note('Use /trace [n].', 33);
        state = traceItem(state, Math.min(n, TRACE_MAX)); sync(); return notify();
      }
      default: return note(`Unknown command ${cmd}. Use /help.`, 33);
    }
  };

  const submit = (line: string): void => {
    if (closing) return;
    const text = line.trim();
    if (paste) {
      if (text === '/end') { const prompt = paste.join('\n'); paste = undefined; notify(); if (prompt.trim()) submit(prompt); return; }
      if (text === '/abort') { paste = undefined; return note('Paste discarded.'); }
      paste.push(line);
      if (paste.join('\n').length > 32_000) { paste = undefined; return note('Paste exceeds 32000 characters; discarded.', 33); }
      return;
    }
    if (!text) return;
    if (text.startsWith('/')) return command(text);
    if (active) {
      if (active.kind === 'shell') return note('A direct command is running. Use /cancel, then submit a task.', 33);
      if (text.startsWith('!')) return note('Wait for the agent, or /cancel before running a direct command.', 33);
      if (text.length > 32_000) return note('Update exceeds 32000 characters.', 33);
      harness.enqueue(text);
      return note('Update queued for the next turn.');
    }
    const host = text.startsWith('!');
    const prompt = host ? text.slice(1).trim() : text;
    if (!prompt) return note('Supply a command after !.', 33);
    if (prompt.length > 32_000) return note('Task exceeds 32000 characters.', 33);
    work = execute(prompt, host ? 'shell' : 'agent');
  };

  note(`╭─ Jev Code · ${model}\n│ ${workspace}\n╰─ Permissions: ${mode} · /help · /exit`);
  if (opts.initialPrompt?.trim()) submit(opts.initialPrompt);

  return {
    snapshot: () => snap ??= { rows, state, color, running: active !== undefined, ...(active ? { started: active.started } : {}), paste: paste !== undefined, mode, closing,
      requestLimit: opts.harness.maxRequests ?? DEFAULT_LIMITS.maxRequests, awaiting: pending !== undefined },
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    submit,
    answer,
    interrupt: hasText => {
      if (active) { cancel(); return false; }
      if (paste || hasText) { paste = undefined; notify(); return true; }
      close(130);
      return false;
    },
    complete: line => COMMANDS.filter(cmd => cmd.startsWith(line)),
    onEvent,
    close,
    closed,
  };
}
