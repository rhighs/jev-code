import { Text } from 'ink';
import { renderLive, type RenderOpts } from '../render-plain.js';
import { paint } from '../terminal-style.js';
import type { TranscriptState } from '../transcript.js';

const PENDING = '__jev_pending__';
const NARROW = 80;
const RESERVED = 9;
const MAX_LINES = 14;

export function LiveArea({ state, opts, rows }: { state: TranscriptState; opts: RenderOpts; rows: number }) {
  if (!state.live) return null;
  const width = opts.width ?? NARROW;
  const max = width < NARROW ? 0 : Math.max(1, Math.min(MAX_LINES, rows - RESERVED));
  const lines = renderLive(state.live, state, opts, max).map(line => line.replace(PENDING, paint(PENDING, 7, opts.color)));
  return <Text>{lines.join('\n')}</Text>;
}
