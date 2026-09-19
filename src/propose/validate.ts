import type { AstAdapter, AstRegistry } from '../ast-adapters.js';
import type { Completion, GenerationError, ProposalRequest } from '../providers/types.js';
import type { Candidate } from './types.js';

export const MAX_CANDIDATE_BYTES = 16_384;

const OPEN = /^\s*```[^\n]*\n/;

export const stripFences = (text: string): string => {
  const m = OPEN.exec(text);
  if (!m) return text;
  const rest = text.slice(m[0].length);
  const closes = [...rest.matchAll(/(?:^|\n)```[ \t]*(?=\n|$)/g)];
  const last = closes.at(-1);
  const body = last?.index === undefined ? rest : rest.slice(0, last.index);
  return `${body.replace(/\n*$/, '')}\n`;
};

const HEREDOC = /^\s*cat\s*>\s*\S+\s*<<-?\s*'?"?(\w+)'?"?\s*\n([\s\S]*?)\n\1\s*$/;

export const unwrap = (text: string): string => {
  let cur = text;
  const t = cur.trim();
  if (t.startsWith('{')) {
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const vals = Object.values(obj);
      if (vals.length === 1 && typeof vals[0] === 'string') cur = vals[0];
    } catch { return cur; }
  }
  const m = HEREDOC.exec(cur);
  return m ? `${m[2]}\n` : cur;
};

export const normalize = (text: string): string =>
  text.replace(/\r\n/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').replace(/\n*$/, '') + '\n';

const errLine = (err: unknown): string => {
  const lines = (err instanceof Error ? err.message : String(err)).split('\n').map(l => l.trim()).filter(Boolean);
  return lines.find(l => /Error:/.test(l)) ?? lines[0] ?? 'invalid';
};

const jsonWrapper = (text: string, path: string | undefined): boolean => {
  if (path?.toLowerCase().endsWith('.json')) return false;
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try { return typeof JSON.parse(t) === 'object'; } catch { return false; }
};

const reasonFor = async (c: Completion, text: string, bytes: number, cur: string | undefined, path: string | undefined, adapter: AstAdapter | undefined, signal: AbortSignal): Promise<string | undefined> => {
  if (c.truncated) return 'truncated';
  if (text.trim() === '') return 'empty';
  if (bytes > MAX_CANDIDATE_BYTES) return 'too large';
  if (cur !== undefined && normalize(text) === cur) return 'unchanged';
  if (jsonWrapper(text, path)) return 'json wrapper';
  if (!adapter) return undefined;
  return adapter.validate(text, signal).then(() => undefined, (err: unknown) => { signal.throwIfAborted(); return errLine(err); });
};

export async function validateCandidates(req: ProposalRequest, completions: Array<Completion | GenerationError>, registry: AstRegistry, signal: AbortSignal): Promise<Candidate[]> {
  const adapter = req.kind === 'file' ? registry.resolve({ argumentsSoFar: { path: req.path } }) : undefined;
  const cur = req.kind === 'file' && req.current !== undefined ? normalize(req.current) : undefined;
  const out = await Promise.all(completions.map(async (c, idx): Promise<Candidate> => {
    const label = String.fromCharCode(65 + idx);
    if ('error' in c) return { label, text: '', valid: false, reason: `generation failed: ${c.error}`, bytes: 0 };
    const text = stripFences(unwrap(stripFences(c.text)));
    const bytes = Buffer.byteLength(text);
    const reason = await reasonFor(c, text, bytes, cur, req.kind === 'file' ? req.path : undefined, adapter, signal);
    return reason === undefined ? { label, text, valid: true, bytes } : { label, text, valid: false, reason, bytes };
  }));
  const seen = new Map<string, string>();
  return out.map(c => {
    if (!c.valid) return c;
    const key = normalize(c.text);
    const first = seen.get(key);
    if (first) return { ...c, valid: false, reason: `duplicate of ${first}` };
    seen.set(key, c.label);
    return c;
  });
}
