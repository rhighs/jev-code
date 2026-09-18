export interface GridCursor { row: number; column: number; offset: number }
export interface GridProgress { rows: number; columns: number; round: number; completed: number; total: number }
export interface TextProgress { decoder: 'grid' | 'ast' | 'choice' | 'search'; step: number; cursor: GridCursor; grid?: GridProgress; bytes?: number; ast?: { production: string; slot: string; symbols: string[]; unit?: string; candidate?: number; kept?: boolean; reason?: string } }
export interface ScoredCell { index: number; row: number; column: number; score: number; value: string; probabilities: Record<string, number> }
export type TextChange = { replace: string } | { grid: GridProgress & { cells: ScoredCell[] } };
export interface CharacterSymbol { key: string; value: string }
const SPECIAL_CHARACTERS: Record<string, { key: string; description: string }> = {
  '"': { key: 'DOUBLE_QUOTE', description: 'a double quotation mark (ASCII 34)' },
  "'": { key: 'SINGLE_QUOTE', description: 'a single quotation mark (ASCII 39)' },
  '\\': { key: 'BACKSLASH', description: 'a backslash (ASCII 92)' },
  ' ': { key: 'SPACE', description: 'one space' },
  '\n': { key: 'NEWLINE', description: 'one newline' },
  '\t': { key: 'TAB', description: 'one tab' },
  '\r': { key: 'CARRIAGE_RETURN', description: 'one carriage return' },
};
export function describeCharacter(value: string): string {
  return SPECIAL_CHARACTERS[value]?.description ?? `the character ${value}`;
}

/** Every choice is one scalar. END marks all positions beyond the text. */
export function characterAlphabet(texts: string[]): CharacterSymbol[] {
  const values = new Map<string, string>();
  for (let code = 33; code <= 126; code++) { const value = String.fromCharCode(code); values.set(SPECIAL_CHARACTERS[value]?.key ?? value, value); }
  values.set('SPACE', ' '); values.set('NEWLINE', '\n'); values.set('TAB', '\t'); values.set('CARRIAGE_RETURN', '\r');
  scan: for (const text of texts) for (const char of text) {
    if (values.size >= 245) break scan;
    const code = char.codePointAt(0)!;
    if (code >= 128 && !(code >= 0xd800 && code <= 0xdfff) && values.size < 245) values.set(char, char);
  }
  return [...values].map(([key, value]) => ({ key, value })).concat({ key: 'END', value: '' });
}

/** Logical coordinates count Unicode scalars, including one cell for a tab. */
export function gridCursor(text: string): GridCursor {
  let row = 0, column = 0, offset = 0;
  for (const char of text) { offset++; if (char === '\n') { row++; column = 0; } else column++; }
  return { row, column, offset };
}
