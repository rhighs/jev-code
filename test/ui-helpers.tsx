/** @jsxRuntime automatic @jsxImportSource react */
import type { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import type { HarnessOptions } from '../src/harness.js';
import type { DecisionProvider } from '../src/types.js';
import { App } from '../src/ui/app.js';
import { createSession, type Session, type SessionOptions } from '../src/ui/session.js';

export interface Ui { stdin: { write: (data: string) => void }; stdout: EventEmitter & { columns: number }; frames: string[]; lastFrame: () => string | undefined; unmount: () => void }
export interface Setup {
  session: Session; ui: Ui; workspace: string; frame: () => string; wait: (re: RegExp) => Promise<string>;
  type: (line: string) => Promise<void>; press: (key: string) => Promise<void>;
}

export const tick = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export const lines = (frame: string): string[] => frame.trimEnd().split('\n');

export async function setup(t: test.TestContext, provider: DecisionProvider, extra: Partial<SessionOptions> = {}, harness: Partial<HarnessOptions> = {}): Promise<Setup> {
  const workspace = await mkdtemp(join(tmpdir(), 'jev-ui-'));
  const session = createSession({ harness: { experimentalGrid: true, workspace, provider, journalDirectory: false, ...harness }, model: 'test-jev', yes: true, tty: true, ...extra });
  const ui: Ui = render(<App session={session} />);
  await tick(10);
  t.after(async () => { session.close(0); await session.closed; ui.unmount(); await rm(workspace, { recursive: true, force: true }); });
  const frame = (): string => stripVTControlCharacters(ui.lastFrame() ?? '');
  const wait = (re: RegExp): Promise<string> => new Promise((done, fail) => {
    const started = Date.now();
    const check = (): void => {
      if (re.test(frame())) return done(frame());
      if (Date.now() - started > 4000) return fail(new Error(`Missing ${re} in frame:\n${frame()}`));
      setTimeout(check, 10);
    };
    check();
  });
  const type = async (line: string): Promise<void> => { ui.stdin.write(line); await tick(); ui.stdin.write('\r'); await tick(); };
  const press = async (key: string): Promise<void> => { ui.stdin.write(key); await tick(); };
  return { session, ui, workspace, frame, wait, type, press };
}
