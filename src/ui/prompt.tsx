import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { paint } from '../terminal-style.js';
import type { Session, Snapshot } from './session.js';

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const commonPrefix = (words: string[]): string => {
  let prefix = words[0] ?? '';
  for (const word of words) while (!word.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
};

export function Prompt({ session, snap, frame, value, onChange: setValue }: { session: Session; snap: Snapshot; frame: number; value: string; onChange: (value: string) => void }) {
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { if (session.interrupt(value !== '')) setValue(''); return; }
    if (!key.tab || !value.startsWith('/')) return;
    const hits = session.complete(value);
    if (hits.length === 1) setValue(`${hits[0]} `);
    else if (hits.length > 1) setValue(commonPrefix(hits));
  });
  const submit = (text: string): void => { setValue(''); session.submit(text); };
  const label = snap.paste ? 'paste› ' : `${snap.running ? `${SPIN[frame % SPIN.length]} ` : ''}› `;
  return (
    <Box>
      <Text>{paint(label, snap.running ? 36 : 1, snap.color)}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={submit} showCursor focus={!snap.awaiting || value !== ''} />
    </Box>
  );
}
