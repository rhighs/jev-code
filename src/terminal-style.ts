export const terminalColor = (tty: boolean): boolean => tty && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
export const paint = (text: string, code: number, enabled: boolean): string => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
export function highlightCode(line: string, enabled: boolean): string {
  if (!enabled) return line;
  return line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$|\b(?:def|return|if|else|elif|for|while|in|import|from|as|break|continue|pass|True|False|None|const|let|function|export|true|false|null)\b|\b\d+(?:\.\d+)?\b/g,
    token => paint(token, token.startsWith('#') ? 2 : /^["']/.test(token) ? 32 : /^\d/.test(token) ? 35 : 36, true));
}
