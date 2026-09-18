import { createElement } from 'react';
import { render } from 'ink';
import { DEFAULT_LIMITS } from '../harness.js';
import { drive } from '../replay.js';
import { isInteractiveTTY, terminalColor } from '../terminal-style.js';
import { initialState, reduce } from '../transcript.js';
import type { HarnessEvent } from '../types.js';
import { App } from './app.js';
import type { Row, Session, Snapshot } from './session.js';

export const replayFooter = (runId: string, speed: number): string => `replay · ${runId} · speed ${speed > 0 ? `${speed}x` : 'instant'} · Ctrl-C to exit`;

export function createReplaySession(color: boolean): Session {
  const listeners = new Set<() => void>();
  let state = initialState(), rows: Row[] = [], printed = 0, running = true, closing = false, snap: Snapshot | undefined;
  let resolveClosed!: (code: number) => void;
  const closed = new Promise<number>(resolve => { resolveClosed = resolve; });
  const notify = (): void => { snap = undefined; for (const fn of listeners) fn(); };
  const close = (code: number): void => {
    if (closing) return;
    closing = true; running = false;
    notify();
    resolveClosed(code);
  };
  return {
    snapshot: () => snap ??= { rows, state, color, running, paste: false, mode: 'auto', closing, requestLimit: DEFAULT_LIMITS.maxRequests, awaiting: false },
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    submit: () => {},
    answer: () => {},
    interrupt: () => { close(0); return false; },
    complete: () => [],
    onEvent: event => {
      state = reduce(state, event);
      rows = [...rows, ...state.items.slice(printed).map((item, i) => ({ id: printed + i, item }))];
      printed = state.items.length;
      if (event.type === 'end') running = false;
      notify();
    },
    close,
    closed,
  };
}

export interface RunReplayOptions { events: HarnessEvent[]; runId: string; speed: number; stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream }

export async function runReplay(opts: RunReplayOptions): Promise<number> {
  const stdin = opts.stdin ?? process.stdin, stdout = opts.stdout ?? process.stderr;
  const session = createReplaySession(terminalColor(isInteractiveTTY(stdin, stdout)));
  const app = render(createElement(App, { session, footer: replayFooter(opts.runId, opts.speed) }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const controller = new AbortController();
  void session.closed.then(() => controller.abort());
  await drive(opts.events, opts.speed, session.onEvent, controller.signal);
  session.close(0);
  const code = await session.closed;
  app.unmount();
  await app.waitUntilExit();
  return code;
}
