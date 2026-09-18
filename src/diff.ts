export interface DiffLine { kind: 'context' | 'remove' | 'add' | 'skip'; text: string }

const split = (text: string): string[] => text === '' ? [] : text.replace(/\n$/, '').split('\n');

export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  const a = split(before), b = split(after);
  const n = a.length, m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const raw: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { raw.push({ kind: 'context', text: a[i]! }); i++; j++; }
    else if (i < n && (j >= m || table[i + 1]![j]! >= table[i]![j + 1]!)) { raw.push({ kind: 'remove', text: a[i]! }); i++; }
    else { raw.push({ kind: 'add', text: b[j]! }); j++; }
  }
  if (!raw.some(line => line.kind !== 'context')) return [];
  const changed = raw.map(line => line.kind !== 'context');
  const keep = raw.map((_, idx) => changed.some((flag, k) => flag && Math.abs(k - idx) <= context));
  const out: DiffLine[] = [];
  let skipped = 0;
  for (const [idx, line] of raw.entries()) {
    if (keep[idx]) {
      if (skipped && out.length) out.push({ kind: 'skip', text: `${skipped} unchanged lines` });
      skipped = 0;
      out.push(line);
    } else skipped++;
  }
  return out;
}

const MARK: Record<DiffLine['kind'], string> = { context: ' ', remove: '-', add: '+', skip: '…' };
export const formatHunk = (hunk: DiffLine[]): string[] => hunk.map(line => `${MARK[line.kind]}${line.text}`);
