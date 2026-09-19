import type { AstAdapter, AstRegistry } from '../ast-adapters.js';
import type { Completion, ProposalRequest } from '../providers/types.js';
import type { Candidate } from './types.js';

export const MAX_CANDIDATE_BYTES = 16_384;

const FENCED = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/;

export const stripFences = (text: string): string => {
  const m = FENCED.exec(text);
  return m ? `${m[1]}\n` : text;
};

export const normalize = (text: string): string =>
  text.replace(/\r\n/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').replace(/\n*$/, '') + '\n';

const errLine = (err: unknown): string => {
  const lines = (err instanceof Error ? err.message : String(err)).split('\n').map(l => l.trim()).filter(Boolean);
  return lines.find(l => /Error:/.test(l)) ?? lines[0] ?? 'invalid';
};

const reasonFor = async (c: Completion, text: string, bytes: number, cur: string | undefined, adapter: AstAdapter | undefined, signal: AbortSignal): Promise<string | undefined> => {
  if (c.truncated) return 'truncated';
  if (text.trim() === '') return 'empty';
  if (bytes > MAX_CANDIDATE_BYTES) return 'too large';
  if (cur !== undefined && normalize(text) === cur) return 'unchanged';
  if (!adapter) return undefined;
  return adapter.validate(text, signal).then(() => undefined, errLine);
};

export async function validateCandidates(req: ProposalRequest, completions: Array<Completion | { error: string }>, registry: AstRegistry, signal: AbortSignal): Promise<Candidate[]> {
  const adapter = req.kind === 'file' ? registry.resolve({ argumentsSoFar: { path: req.path } }) : undefined;
  const cur = req.current === undefined ? undefined : normalize(req.current);
  const out: Candidate[] = [];
  for (const [idx, c] of completions.entries()) {
    const label = String.fromCharCode(65 + idx);
    if ('error' in c) { out.push({ label, text: '', valid: false, reason: `generation failed: ${c.error}`, bytes: 0 }); continue; }
    const text = stripFences(c.text);
    const bytes = Buffer.byteLength(text);
    const reason = await reasonFor(c, text, bytes, cur, adapter, signal);
    out.push(reason === undefined ? { label, text, valid: true, bytes } : { label, text, valid: false, reason, bytes });
  }
  return out;
}
