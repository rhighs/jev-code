import { stripVTControlCharacters } from 'node:util';

type Tty = { isTTY?: boolean | undefined };
export const isInteractiveTTY = (stdin: Tty, out: Tty): boolean => Boolean(stdin.isTTY && out.isTTY);
export const terminalColor = (tty: boolean): boolean => tty && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
export const paint = (text: string, code: number, enabled: boolean): string => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
export function highlightCode(line: string, enabled: boolean): string {
  if (!enabled) return line;
  return line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$|\b(?:def|return|if|else|elif|for|while|in|import|from|as|break|continue|pass|True|False|None|const|let|function|export|true|false|null)\b|\b\d+(?:\.\d+)?\b/g,
    token => paint(token, token.startsWith('#') ? 2 : /^["']/.test(token) ? 32 : /^\d/.test(token) ? 35 : 36, true));
}

/** Preserve the exact text; escape controls only when presenting it to the terminal. */
export const displayText = (text: string): string => stripVTControlCharacters(text).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g,
  char => char === '\t' ? '    ' : JSON.stringify(char).slice(1, -1));

export function fitLine(text: string, width: number): string {
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
