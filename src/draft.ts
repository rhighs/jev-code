import { stripVTControlCharacters } from 'node:util';
import { highlightCode, paint } from './terminal-style.js';
import type { HarnessEvent, TextEventData } from './types.js';

/** Preserve the exact draft; escape controls only when presenting it to the terminal. */
const displayText = (text: string): string => stripVTControlCharacters(text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g,
  char => char === '\t' ? '    ' : JSON.stringify(char).slice(1, -1)));

function fitLine(text: string, width: number): string {
  text = displayText(text).replace(/\n/g, '↵');
  let result = '', used = 0;
  for (const char of text) {
    // Conservatively count non-Latin scalars as wide to keep the pane from wrapping.
    const size = char.codePointAt(0)! >= 0x1100 ? 2 : 1;
    if (used + size > width - 1) return result + '…';
    result += char;
    used += size;
  }
  return result;
}

export class GenerationDisplay {
  private action = 'text';
  private path: string | undefined;
  private readonly drafts = new Map<string, { text: string; data: TextEventData; cells: Array<string | null>; round: number }>();
  private current: { text: string; data: TextEventData; cells: Array<string | null>; round: number } | undefined;
  visible = false;

  /** Plain output streams deltas immediately; TTY callers render a revisable pane instead. */
  consume(event: HarnessEvent): string {
    if (event.type === 'action') { this.action = event.data.tool; this.path = undefined; this.drafts.clear(); return ''; }
    if (event.type !== 'text') return '';
    const identity = `${event.runId}:${event.turn}:${this.action}:${event.data.field}`;
    let output = '';
    let draft = this.drafts.get(identity);
    if (!draft) {
      draft = { text: '', data: event.data, cells: [], round: 0 };
      this.drafts.set(identity, draft);
      output += `\nDraft · ${this.action}.${event.data.field} · ${event.data.decoder}\n`;
    }
    if (event.data.field === 'path' && event.data.change && 'replace' in event.data.change) this.path = event.data.change.replace;
    this.current = draft;
    this.visible = true;
    draft.data = event.data;
    const change = event.data.change;
    if (change && 'grid' in change) {
      const grid = change.grid;
      if (draft.round !== grid.round) { draft.round = grid.round; draft.cells = Array(grid.total).fill(null); }
      for (const cell of grid.cells) draft.cells[cell.index] = cell.value;
      output += `[Grid · ${this.action}.${event.data.field} · round ${grid.round} · ${grid.completed}/${grid.total} cells]\n`;
      const rows = [...new Set(grid.cells.map(cell => cell.row))];
      for (const row of rows) output += `${String(row + 1).padStart(3)} | ${this.gridLine(draft.cells.slice(row * grid.columns, (row + 1) * grid.columns))}\n`;
    } else if (change && 'replace' in change) {
      draft.text = change.replace;
      output += event.data.ast
        ? `\nAST · ${event.data.ast.slot} → ${event.data.ast.production}\n${displayText(draft.text)}\n`
        : `\nDecoded · ${this.action}.${event.data.field}\n${displayText(draft.text)}`;
    }
    if (event.data.done) { output += '\n[Draft complete]\n'; draft.cells = []; this.drafts.delete(identity); }
    return output;
  }

  lines(columns: number, maxLines = 8, color = false): string[] {
    if (!this.current) return [];
    const width = Math.max(1, columns);
    const { field, decoder, cursor, bytes, done, grid, ast, step } = this.current.data;
    const header = `Draft · ${this.action}.${field} · ${decoder} · ${ast && !done ? `step ${step} · ${ast.unit ? `${ast.unit} · ` : ''}${ast.slot} → ${ast.production}` : grid && !done ? `${grid.completed}/${grid.total} cells · round ${grid.round}` : `${cursor.row + 1}:${cursor.column + 1} · ${bytes} B`}${done ? ' · complete' : ''}`;
    if (grid && !done) {
      const result = [fitLine(header, width)];
      for (let row = 0; row < Math.min(grid.rows, maxLines); row++) {
        result.push(fitLine(`${String(row + 1).padStart(3)} | ${this.gridLine(this.current.cells.slice(row * grid.columns, (row + 1) * grid.columns))}`, width));
      }
      if (grid.rows > maxLines) result.push(fitLine('… additional grid rows', width));
      return result;
    }
    const tail = this.current.text.slice(-8000).split('\n');
    const omitted = tail.length > maxLines || this.current.text.length > 8000;
    const source = ['content', 'new_text', 'old_text'].includes(field);
    if (source) {
      const selected = tail.slice(-maxLines);
      const start = Math.max(1, tail.length - selected.length + 1);
      const title = `${this.path ?? 'File preview'} · ${done ? 'ready to write' : 'building'} · ${bytes} B`;
      const detail = done ? 'Complete source · awaiting tool execution' : ast ? `AST step ${step} · ${ast.unit ? `${ast.unit} · ` : ''}${ast.slot} → ${ast.production}` : 'Draft · not yet written';
      const rows = selected.map((line, index) => {
        const prefix = `│ ${String(start + index).padStart(3)}  `;
        return paint(prefix, 2, color) + highlightCode(fitLine(displayText(line), Math.max(1, width - prefix.length)), color);
      });
      return [paint(fitLine(`╭─ ${title}`, width), 36, color),
        ...(omitted ? [paint(fitLine('│ … earlier lines', width), 2, color)] : []), ...rows,
        paint(fitLine(`╰─ ${detail}`, width), done ? 32 : 2, color)];
    }
    const lines = tail.slice(-maxLines).map(line => fitLine(displayText(line), width));
    return [paint(fitLine(header, width), 2, color), ...(omitted ? [fitLine('… earlier content above this preview', width)] : []), ...lines];
  }

  private gridLine(cells: Array<string | null>): string {
    return cells.map(value => {
      switch (value) {
        case null: return '·';
        case '': return '∅';
        case '\n': return '↵';
        case '\t': return '⇥';
        default: return displayText(value);
      }
    }).join('');
  }

  hide(): void { this.visible = false; }
}
