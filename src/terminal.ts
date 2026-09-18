import { createInterface, clearScreenDown, cursorTo, moveCursor, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { open } from 'node:fs/promises';
import { resolveWorkspacePath } from './workspace.js';
import { Harness, type HarnessOptions } from './harness.js';
import { runBash } from './tools.js';
import { GenerationDisplay } from './draft.js';
import { paint, terminalColor } from './terminal-style.js';
import { formatDuration } from './timing.js';
import type { HarnessEvent, RunResult, RunStatus, Tool, ToolRecord, ToolResult } from './types.js';

type SessionStatus = RunStatus | 'working';
interface OutputLine { chunks: string[]; length: number; truncated: boolean }
const MAX_LINE_CHARACTERS = 32_000;

const COMMANDS = ['/help', '/status', '/plan', '/history', '/files', '/show', '/clear', '/cancel', '/permissions', '/paste', '/exit'];
const HELP = `Type a task or a follow-up. During a run, new text updates the task at the next turn.
  /help                  Show these commands
  /status                Show current activity and the last run
  /plan                  Show the latest plan
  /history               Show recent tasks and their outcomes
  /files                 List files written or edited in this session
  /show <path>           View a file with line numbers without a model request
  /clear                 Start a fresh conversation (keeps files and journals)
  /cancel                Cancel the current run and stay in the session
  /permissions ask|auto  Confirm agent shell commands, or allow them automatically
  /paste                 Enter a multiline task; /end submits, /abort discards
  /exit                  Cancel current work and exit
  !<bash command>        Run your command directly and share its result with Jev
Ctrl-C cancels current work; at an empty idle prompt it exits. Tab completes commands.`;

export interface TerminalOptions {
  harness: Omit<HarnessOptions, 'onEvent' | 'authorize'>;
  input: Readable;
  output: Writable;
  model: string;
  initialPrompt?: string;
  yes?: boolean;
  confirmWrites?: boolean;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
}

interface Permission {
  resolve: (allowed: boolean) => void;
  signal: AbortSignal;
  abort: () => void;
}

export class TerminalSession {
  readonly harness: Harness;
  private readline: Interface | undefined;
  private readonly tty: boolean;
  private readonly color: boolean;
  private animation: NodeJS.Timeout | undefined;
  private frame = 0;
  private active: { controller: AbortController; kind: 'agent' | 'shell'; started: number } | undefined;
  private work: Promise<void> | undefined;
  private permission: Permission | undefined;
  private paste: string[] | undefined;
  private pasteLength = 0;
  private closing = false;
  private permissionMode: 'ask' | 'auto';
  private activity = 'ready';
  private model: string;
  private turn = 0;
  private requests = 0;
  private plan = '';
  private lastRun: RunResult | undefined;
  private readonly generatedFiles = new Set<string>();
  private readonly history: Array<{ prompt: string; status: SessionStatus; durationMs?: number }> = [];
  private readonly outputLines: Record<'stdout' | 'stderr', OutputLine> = {
    stdout: { chunks: [], length: 0, truncated: false }, stderr: { chunks: [], length: 0, truncated: false },
  };
  private lastProgressRedraw = 0;
  private readonly draft = new GenerationDisplay();
  private previewRows = 0;
  private previewTimer: NodeJS.Timeout | undefined;
  private streamed = false;
  private exitCode = 0;

  constructor(private readonly options: TerminalOptions) {
    this.tty = Boolean((options.input as { isTTY?: boolean }).isTTY && (options.output as { isTTY?: boolean }).isTTY);
    this.color = terminalColor(this.tty);
    this.permissionMode = options.yes ? 'auto' : 'ask';
    this.model = options.model;
    this.harness = new Harness({ ...options.harness,
      onEvent: async event => { this.onEvent(event); await options.onEvent?.(event); },
      authorize: (tool, args, signal) => this.authorize(tool, args, signal),
    });
  }

  private print(message: string): void {
    this.erasePrompt();
    const clean = stripVTControlCharacters(message);
    this.options.output.write(paint(clean, /(?:✗|error|cancelled|limited)/.test(clean) ? 33 : /(?:✓|completed|finished)/.test(clean) ? 32 : 0, this.color) + '\n');
    this.refreshPrompt();
  }

  private refreshPrompt(): void {
    if (!this.readline || this.closing) return;
    this.erasePrompt();
    if (this.tty && this.draft.visible) {
      const columns = Math.max(1, ((this.options.output as { columns?: number }).columns ?? 80) - 1);
      const rows = Math.max(1, Math.min(14, ((this.options.output as { rows?: number }).rows ?? 24) - 9));
      const lines = this.draft.lines(columns, rows, this.color);
      this.options.output.write(lines.join('\n') + '\n');
      this.previewRows = lines.length;
    }
    const indicator = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][this.frame++ % 10];
    const label = this.paste ? 'paste' : this.permission ? 'allow [y/n]' : this.active ? `${this.tty ? indicator + ' ' : ''}you · ${this.activity} · ${formatDuration(performance.now() - this.active.started)}` : 'you';
    this.readline.setPrompt(paint(`${label}> `, this.permission ? 33 : this.active ? 36 : 0, this.color));
    this.readline.prompt(true);
  }

  private erasePrompt(): void {
    if (!this.tty || !this.readline) return;
    cursorTo(this.options.output, 0);
    moveCursor(this.options.output, 0, -(this.readline.getCursorPos().rows + this.previewRows));
    clearScreenDown(this.options.output);
    this.previewRows = 0;
  }

  private finishDraft(reason?: string): void {
    if (this.previewTimer) { clearTimeout(this.previewTimer); this.previewTimer = undefined; }
    if (!this.draft.visible) return;
    if (this.tty) {
      this.erasePrompt();
      const columns = Math.max(1, ((this.options.output as { columns?: number }).columns ?? 80) - 1);
      this.options.output.write(this.draft.lines(columns, 60, this.color).join('\n') + '\n');
    }
    this.draft.hide();
    if (reason) this.options.output.write(`[Draft ${reason}]\n`);
    this.refreshPrompt();
  }

  private progress(activity: string, throttle = false): void {
    this.activity = activity;
    if (this.tty && (!throttle || Date.now() - this.lastProgressRedraw >= 100)) {
      this.lastProgressRedraw = Date.now();
      this.refreshPrompt();
    }
  }

  private flushLine(stream: 'stdout' | 'stderr', complete = false): void {
    const line = this.outputLines[stream];
    if (complete || line.length || line.truncated) {
      this.print(`  ${stream === 'stderr' ? 'stderr: ' : ''}${line.chunks.join('')}${line.truncated ? ' [line truncated]' : ''}`);
    }
    line.chunks.length = 0;
    line.length = 0;
    line.truncated = false;
  }

  private flushOutput(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      this.flushLine(stream);
    }
  }

  private streamOutput(stream: 'stdout' | 'stderr', text: string): void {
    this.streamed = true;
    const clean = stripVTControlCharacters(text).replace(/\r/g, '');
    const line = this.outputLines[stream];
    let offset = 0;
    while (offset < clean.length) {
      const newline = clean.indexOf('\n', offset);
      const end = newline < 0 ? clean.length : newline;
      const retained = Math.min(end - offset, MAX_LINE_CHARACTERS - line.length);
      if (retained) { line.chunks.push(clean.slice(offset, offset + retained)); line.length += retained; }
      if (retained < end - offset) line.truncated = true;
      if (newline < 0) break;
      this.flushLine(stream, true);
      offset = newline + 1;
    }
  }

  private reportResult(name: string, result: ToolResult): void {
    const data = result.data;
    const detail = data?.cancelled ? ' · cancelled' : data?.timedOut ? ' · timed out' :
      data?.exitCode !== undefined ? ` · exit ${String(data.exitCode)}` : '';
    this.print(`  ${result.ok ? '✓' : '✗'} ${name}${detail}`);
    if (data?.truncated) this.print('  Output truncated.');
  }

  private async showFile(path: string): Promise<void> {
    if (!path.trim()) throw new Error('Use /show <path>.');
    const resolved = await resolveWorkspacePath(this.options.harness.workspace, path, this.options.harness.allowOutsideWorkspace ?? false);
    const file = await open(resolved, 'r');
    try {
      const bytes = Buffer.alloc(64_001);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const text = stripVTControlCharacters(bytes.subarray(0, Math.min(bytesRead, 64_000)).toString('utf8')).replace(/\r/g, '');
      const lines = text.split('\n');
      this.print(`╭─ ${path}\n${lines.slice(0, 300).map((line, index) => `│ ${String(index + 1).padStart(3)}  ${line}`).join('\n')}\n╰─ ${bytesRead > 64_000 || lines.length > 300 ? 'Preview truncated at 64 KB / 300 lines' : `${bytesRead} B`}`);
    } finally { await file.close(); }
  }

  private onEvent(event: HarnessEvent): void {
    if (event.type === 'action') this.finishDraft('abandoned; not executed');
    const text = this.draft.consume(event);
    switch (event.type) {
      case 'start': this.print('\nJev is working. Type an update, /cancel, or /status.'); break;
      case 'turn': this.turn = event.turn; this.progress(`turn ${event.turn} · deciding`); break;
      case 'turn_end': this.print(`  Turn ${event.turn} finished · ${formatDuration(event.data.durationMs)} · ${formatDuration(event.data.elapsedMs)} total elapsed · ${event.data.requests} requests`); break;
      case 'action': this.print(`  Turn ${event.turn} · ${String(event.data.tool)}`); break;
      case 'decision':
        this.requests++;
        if (typeof event.data.model === 'string') this.model = event.data.model;
        break;
      case 'text': {
        this.activity = `turn ${event.turn} · generating ${event.data.field} · ${event.data.bytes} B`;
        if (!this.tty) this.options.output.write(text);
        else if (event.data.decoder === 'search' && event.data.ast) {
          const { unit, candidate, kept, reason } = event.data.ast;
          this.print(`  search · ${unit ?? event.data.field} · candidate ${candidate} · ${kept ? 'kept' : `dropped (${reason ?? 'scored lower'})`}`);
        }
        if (event.data.done) this.finishDraft();
        else if (this.tty && !this.previewTimer) {
          this.previewTimer = setTimeout(() => { this.previewTimer = undefined; this.refreshPrompt(); }, 50);
          this.previewTimer.unref();
        }
        break;
      }
      case 'tool_start': {
        this.streamed = false;
        const args = event.data.args;
        this.print(`  → ${String(event.data.tool)} ${String(args.command ?? args.path ?? '')}`);
        this.progress(`turn ${event.turn} · ${String(event.data.tool)}`);
        break;
      }
      case 'tool_output': this.streamOutput(event.data.stream, event.data.text); break;
      case 'tool_end': {
        this.flushOutput();
        const record = event.data;
        if (record.result.ok && ['write_file', 'edit_file'].includes(record.tool) && typeof record.args.path === 'string') this.generatedFiles.add(record.args.path);
        this.reportResult(record.tool, record.result);
        if (!this.streamed && record.result.output) this.print(record.result.output.slice(0, 3000));
        if (typeof record.result.data?.plan === 'string') this.plan = record.result.data.plan;
        this.streamed = false;
        break;
      }
      case 'input': this.print('  Task update applied.'); break;
      case 'end': this.finishDraft('incomplete; not executed'); break;
    }
  }

  private authorize(tool: Tool, args: ToolRecord['args'], signal: AbortSignal): Promise<boolean> | boolean {
    if (this.permissionMode === 'auto' || (tool.effect !== 'shell' && !(this.options.confirmWrites && tool.effect === 'write'))) return true;
    signal.throwIfAborted();
    this.print(`\nAllow ${tool.name}?\n${JSON.stringify(args, null, 2).slice(0, 6000)}`);
    return new Promise(resolve => {
      const abort = (): void => this.answerPermission(false);
      this.permission = { resolve, signal, abort };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      this.refreshPrompt();
    });
  }

  private answerPermission(allowed: boolean): void {
    const pending = this.permission;
    if (!pending) return;
    this.permission = undefined;
    pending.signal.removeEventListener('abort', pending.abort);
    pending.resolve(allowed);
    this.refreshPrompt();
  }

  private cancel(): void {
    if (!this.active) { this.print('No run is active.'); return; }
    this.progress('cancelling');
    this.active.controller.abort(new Error('Cancelled by user.'));
    this.answerPermission(false);
  }

  private async execute(prompt: string, kind: 'agent' | 'shell'): Promise<void> {
    const entry: { prompt: string; status: SessionStatus; durationMs?: number } = { prompt, status: 'working' };
    this.history.push(entry);
    if (this.history.length > 20) this.history.shift();
    this.turn = 0;
    this.requests = 0;
    this.active = { controller: new AbortController(), kind, started: performance.now() };
    this.progress(kind === 'agent' ? 'starting' : 'bash');
    try {
      if (kind === 'shell') {
        this.streamed = false;
        this.print(`  $ ${prompt}`);
        const result = await runBash(prompt, this.options.harness.workspace, 600_000, this.active.controller.signal, 32_000,
          async (stream, text) => this.streamOutput(stream, text));
        this.flushOutput();
        this.harness.observe({ turn: 0, tool: 'bash', args: { command: prompt, cwd: this.options.harness.workspace }, result });
        entry.status = result.data?.cancelled ? 'cancelled' : result.ok ? 'completed' : 'error';
        this.reportResult('Bash', result);
      } else {
        const result = await this.harness.run(prompt, this.active.controller.signal);
        this.lastRun = result;
        entry.status = result.status;
        entry.durationMs = result.durationMs;
        this.print(`\nJev · ${result.status}\n${result.summary}\n${formatDuration(result.durationMs)} elapsed · ${result.turns} turns · ${result.requests} requests · ${result.usage.inputTokens} input tokens\nRun: ${result.id}\n`);
      }
    } catch (error) {
      entry.status = this.active.controller.signal.aborted ? 'cancelled' : 'error';
      this.print(`${entry.status}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      entry.durationMs ??= Math.round(performance.now() - this.active.started);
      this.answerPermission(false);
      this.active = undefined;
      this.activity = 'ready';
      this.refreshPrompt();
    }
  }

  private submit(text: string): void {
    if (this.active) {
      if (this.active.kind === 'shell') { this.print('A direct command is running. Use /cancel, then submit a task.'); return; }
      if (text.startsWith('!')) { this.print('Wait for the agent, or /cancel before running a direct command.'); return; }
      this.harness.enqueue(text);
      if (this.permission) this.answerPermission(false);
      this.print('Update queued for the next turn.');
      return;
    }
    const shell = text.startsWith('!');
    const prompt = shell ? text.slice(1).trim() : text;
    if (!prompt) { this.print('Supply a command after !.'); return; }
    if (prompt.length > 32_000) { this.print('Task exceeds 32000 characters.'); return; }
    this.work = this.execute(prompt, shell ? 'shell' : 'agent');
  }

  private handleLine(line: string): void {
    if (this.closing) return;
    const text = line.trim();
    if (this.paste) {
      if (text === '/end') {
        const prompt = this.paste.join('\n');
        this.paste = undefined;
        if (prompt.trim()) this.submit(prompt);
      } else if (text === '/abort') { this.paste = undefined; this.print('Paste discarded.'); }
      else {
        this.pasteLength += line.length + 1;
        if (this.pasteLength > 32_000) { this.paste = undefined; this.print('Paste exceeds 32000 characters; discarded.'); }
        else this.paste.push(line);
      }
      this.refreshPrompt();
      return;
    }
    if (!text) { this.refreshPrompt(); return; }
    if (this.permission && /^(?:y|yes|n|no)$/i.test(text)) { this.answerPermission(/^y/i.test(text)); return; }
    if (text.startsWith('/')) {
      const [command, ...args] = text.split(/\s+/);
      switch (command) {
        case '/help': this.print(HELP); break;
        case '/exit': this.exitCode = 0; this.closing = true; this.active?.controller.abort(new Error('Session closed.')); this.answerPermission(false); this.readline?.close(); break;
        case '/cancel': this.cancel(); break;
        case '/status': this.print(`Workspace: ${this.options.harness.workspace}\nModel: ${this.model}\nPermissions: ${this.permissionMode}\nActivity: ${this.activity}${this.active ? ` · ${formatDuration(performance.now() - this.active.started)} elapsed` : ''}\nCurrent turn: ${this.turn} · ${this.requests} decisions answered${this.lastRun ? `\nLast run: ${this.lastRun.status} · ${formatDuration(this.lastRun.durationMs)} · ${this.lastRun.id}` : ''}`); break;
        case '/plan': this.print(this.plan || 'No plan recorded yet.'); break;
        case '/history': this.print(this.history.map((entry, i) => `${i + 1}. [${entry.status}] ${entry.prompt.replace(/\n/g, ' ').slice(0, 200)}${entry.durationMs === undefined ? '' : ` · ${formatDuration(entry.durationMs)}`}`).join('\n') || 'No tasks yet.'); break;
        case '/files': this.print([...this.generatedFiles].map(path => `  ${path}`).join('\n') || 'No files generated in this session yet.'); break;
        case '/show': void this.showFile(text.slice(command.length).trim()).catch(error => this.print(`Error: ${error instanceof Error ? error.message : String(error)}`)); break;
        case '/clear':
          if (this.active) this.print('Use /cancel and wait for it to stop before /clear.');
          else { this.harness.reset(); this.history.length = 0; this.plan = ''; this.lastRun = undefined; this.print('Fresh conversation. Files and journals kept.'); }
          break;
        case '/permissions':
          if (args.length === 0) this.print(`Permissions: ${this.permissionMode}. Use /permissions ask or /permissions auto.`);
          else if (args.length === 1 && (args[0] === 'ask' || args[0] === 'auto')) {
            this.permissionMode = args[0];
            this.print(`Permissions: ${this.permissionMode}.`);
            if (this.permission && args[0] === 'auto') this.answerPermission(true);
          } else this.print('Use /permissions ask or /permissions auto.');
          break;
        case '/paste': this.paste = []; this.pasteLength = 0; this.print('Paste a multiline task. /end submits; /abort discards.'); break;
        default: this.print(`Unknown command ${command}. Use /help.`);
      }
    } else this.submit(text);
    this.refreshPrompt();
  }

  async run(): Promise<number> {
    if (this.readline) throw new Error('This terminal session has already started.');
    this.readline = createInterface({ input: this.options.input, output: this.options.output, terminal: this.tty,
      historySize: 100, removeHistoryDuplicates: true,
      completer: (line: string) => { const hits = COMMANDS.filter(command => command.startsWith(line)); return [hits, line]; },
    });
    const interrupt = (): void => {
      if (this.active) this.cancel();
      else if (this.paste || this.readline?.line) { this.paste = undefined; this.readline?.write(null, { ctrl: true, name: 'u' }); this.refreshPrompt(); }
      else { this.exitCode = 130; this.closing = true; this.readline?.close(); }
    };
    this.readline.on('SIGINT', interrupt);
    process.on('SIGINT', interrupt);
    this.readline.on('line', line => {
      try { this.handleLine(line); }
      catch (error) { this.print(`Error: ${error instanceof Error ? error.message : String(error)}`); }
    });
    const closed = new Promise<void>(resolve => this.readline!.once('close', resolve));
    try {
      this.print(`\n╭─ Jev Code · ${this.model}\n│ ${this.options.harness.workspace}\n╰─ Permissions: ${this.permissionMode} · /help · /exit\n`);
      if (this.tty) { this.animation = setInterval(() => { if (this.active && !this.closing) this.refreshPrompt(); }, 120); this.animation.unref(); }
      if (this.options.initialPrompt?.trim()) this.submit(this.options.initialPrompt);
      await closed;
      this.closing = true;
      this.active?.controller.abort(new Error('Terminal input closed.'));
      this.answerPermission(false);
      await this.work;
      return this.exitCode;
    } finally {
      if (this.previewTimer) clearTimeout(this.previewTimer);
      if (this.animation) clearInterval(this.animation);
      process.removeListener('SIGINT', interrupt);
      this.readline.close();
    }
  }
}
