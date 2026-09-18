import { Static, Text } from 'ink';
import { renderItem, type RenderOpts } from '../render-plain.js';
import { paint } from '../terminal-style.js';
import type { Row } from './session.js';

const rowText = (row: Row, opts: RenderOpts): string =>
  'item' in row ? renderItem(row.item, opts).join('\n') : row.note.split('\n').map(line => paint(line, row.tone, opts.color && row.tone !== 0)).join('\n');

export function TranscriptView({ rows, opts }: { rows: Row[]; opts: RenderOpts }) {
  return <Static items={rows}>{row => <Text key={row.id}>{rowText(row, opts)}</Text>}</Static>;
}
