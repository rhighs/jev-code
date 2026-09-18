import { Text, useApp, useWindowSize } from 'ink';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RenderOpts } from '../render-plain.js';
import { fitLine, paint } from '../terminal-style.js';
import { formatDuration } from '../timing.js';
import { LiveArea } from './live-area.js';
import { Prompt } from './prompt.js';
import type { Snapshot, Session } from './session.js';
import { TranscriptView } from './transcript-view.js';

const phase = (snap: Snapshot): string => {
  const live = snap.state.live;
  if (!live) return snap.running ? 'deciding' : 'you';
  switch (live.card.status) {
    case 'generating': return `generating ${live.field ?? ''}`.trim();
    case 'running': return `running ${live.card.tool}`;
    case 'awaiting': return `approve ${live.card.tool}`;
    default: return 'deciding';
  }
};

const statusLine = (snap: Snapshot, width: number): string => {
  const { state } = snap;
  const elapsed = snap.started === undefined ? state.elapsedMs : performance.now() - snap.started;
  const limit = state.limits?.requests ?? snap.requestLimit;
  return fitLine(`${formatDuration(elapsed)} · turn ${state.turn} · ${state.requests}/${limit} req · ${phase(snap)}`, width);
};

export function App({ session }: { session: Session }) {
  const snap = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [frame, setFrame] = useState(0);
  useEffect(() => { if (snap.closing) exit(); }, [snap.closing, exit]);
  useEffect(() => {
    if (!snap.running) return;
    const id = setInterval(() => setFrame(f => f + 1), 120);
    return () => clearInterval(id);
  }, [snap.running]);
  const opts: RenderOpts = { color: snap.color, width: columns };
  return (
    <>
      <TranscriptView rows={snap.rows} opts={opts} />
      <LiveArea state={snap.state} opts={opts} rows={rows} />
      <Text>{paint(statusLine(snap, columns), 2, snap.color)}</Text>
      <Prompt session={session} snap={snap} frame={frame} />
    </>
  );
}
