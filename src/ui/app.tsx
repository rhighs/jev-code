import { Text, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RenderOpts } from '../render-plain.js';
import { fitLine, paint } from '../terminal-style.js';
import { formatDuration } from '../timing.js';
import { Approval } from './approval.js';
import { LiveArea } from './live-area.js';
import { Prompt } from './prompt.js';
import { APPROVAL_KEYS, type Snapshot, type Session } from './session.js';
import { TranscriptView } from './transcript-view.js';

const phase = (snap: Snapshot): string => {
  const live = snap.state.live;
  if (!live) return snap.running ? 'deciding' : 'you';
  switch (live.card.status) {
    case 'generating': return `generating ${live.field ?? ''}`.trim();
    case 'running': return `running ${live.card.tool}`;
    default: return 'deciding';
  }
};

const statusLine = (snap: Snapshot, width: number): string => {
  const { state } = snap;
  if (snap.awaiting) return fitLine(APPROVAL_KEYS, width);
  const elapsed = snap.started === undefined ? state.elapsedMs : performance.now() - snap.started;
  const limit = state.limits?.requests ?? snap.requestLimit;
  return fitLine(`${formatDuration(elapsed)} · turn ${state.turn} · ${state.requests}/${limit} req · ${phase(snap)}`, width);
};

export function App({ session, footer }: { session: Session; footer?: string }) {
  const snap = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [frame, setFrame] = useState(0);
  useEffect(() => { if (snap.closing) exit(); }, [snap.closing, exit]);
  useEffect(() => {
    if (!snap.running || footer !== undefined) return;
    const id = setInterval(() => setFrame(f => f + 1), 120);
    return () => clearInterval(id);
  }, [snap.running, footer]);
  const opts: RenderOpts = { color: snap.color, width: columns };
  return (
    <>
      <TranscriptView rows={snap.rows} opts={opts} />
      <LiveArea state={snap.state} opts={opts} rows={rows} />
      <Text>{paint(statusLine(snap, columns), snap.awaiting ? 33 : 2, snap.color)}</Text>
      {footer === undefined
        ? <><Approval session={session} active={snap.awaiting} /><Prompt session={session} snap={snap} frame={frame} /></>
        : <Footer session={session} text={fitLine(footer, columns)} color={snap.color} />}
    </>
  );
}

function Footer({ session, text, color }: { session: Session; text: string; color: boolean }) {
  useInput((input, key) => { if (key.ctrl && input === 'c') session.close(0); });
  return <Text>{paint(text, 2, color)}</Text>;
}
