import { createInterface } from 'node:readline/promises';
import { Harness, type HarnessOptions } from './harness.js';
import { renderItem, renderStep, renderSummary } from './render-plain.js';
import { terminalColor } from './terminal-style.js';
import { initialState, reduce, type TranscriptState } from './transcript.js';
import type { HarnessEvent, RunResult, ToolRecord } from './types.js';

type Out = NodeJS.WritableStream & { isTTY?: boolean };
type In = NodeJS.ReadableStream & { isTTY?: boolean };

export interface Printer {
  onEvent: (event: HarnessEvent) => void;
  permission: (tool: string, args: ToolRecord['args']) => void;
  resolve: (tool: string, allowed: boolean) => void;
  summary: () => string[];
  state: () => TranscriptState;
}

/** Cards land on stderr as they complete; with a json stream every event goes there instead and nothing is rendered. */
export function createPrinter(stderr: Out, json?: Out): Printer {
  const opts = { color: terminalColor(Boolean(stderr.isTTY)) };
  let state = initialState(), printed = 0;
  const write = (lines: string[]): void => { if (lines.length) stderr.write(lines.join('\n') + '\n'); };
  return {
    onEvent: event => {
      if (json) { json.write(JSON.stringify(event) + '\n'); return; }
      state = reduce(state, event);
      if (event.type === 'text' && event.data.ast && state.live) write([renderStep(state.live, event.data.decoder === 'search')]);
      for (const item of state.items.slice(printed)) if (item.kind !== 'summary') write(renderItem(item, opts));
      printed = state.items.length;
    },
    permission: (tool, args) => {
      state = reduce(state, { type: 'permission', data: { tool, args } });
      if (state.live) write(renderItem(state.live.card, opts));
    },
    resolve: (tool, allowed) => { state = reduce(state, { type: 'permission_result', data: { tool, allowed } }); },
    summary: () => { const item = state.items.at(-1); return item?.kind === 'summary' ? renderSummary(item) : []; },
    state: () => state,
  };
}

export interface PrintOptions {
  harness: Omit<HarnessOptions, 'onEvent' | 'authorize'>;
  prompt: string;
  stdin: In; stdout: Out; stderr: Out;
  yes: boolean; confirmWrites: boolean; json: boolean;
  signal: AbortSignal;
  onInterrupt?: () => void;
}

export async function printRun(opts: PrintOptions): Promise<RunResult> {
  const printer = createPrinter(opts.stderr, opts.json ? opts.stdout : undefined);
  const readline = opts.stdin.isTTY ? createInterface({ input: opts.stdin, output: opts.stderr }) : undefined;
  if (opts.onInterrupt) readline?.on('SIGINT', opts.onInterrupt);
  const harness = new Harness({ ...opts.harness, onEvent: printer.onEvent,
    authorize: async (tool, args, signal) => {
      if (opts.yes || (tool.effect !== 'shell' && !(opts.confirmWrites && tool.effect === 'write'))) return true;
      printer.permission(tool.name, args);
      const allowed = readline ? /^y(?:es)?$/i.test((await readline.question('Execute? [y/N] ', { signal })).trim()) : false;
      if (!readline) opts.stderr.write(`Tool ${tool.name} needs confirmation; run with --yes for unattended execution.\n`);
      printer.resolve(tool.name, allowed);
      return allowed;
    },
  });
  try {
    const result = await harness.run(opts.prompt, opts.signal);
    if (!opts.json) opts.stdout.write(printer.summary().join('\n') + '\n');
    return result;
  } finally { readline?.close(); }
}
