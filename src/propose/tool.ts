import { lstat, readFile } from 'node:fs/promises';
import type { AstRegistry } from '../ast-adapters.js';
import { diffLines, formatHunk } from '../diff.js';
import type { Completion, ProposalProvider, ProposalRequest } from '../providers/types.js';
import { atomicWrite } from '../tools.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import type { Candidate, CandidateSummary } from './types.js';
import { validateCandidates } from './validate.js';

type Args = Record<string, string | number | boolean>;
const MAX_PREVIEW = 4096, MAX_CRITERION = 80, MAX_HUNK = 120, MAX_FILE = 2_000_000;
const INSTRUCTION = 'Select the candidate that best accomplishes the objective under the constraints, or reject all of them.';
const REJECT = 'No candidate is acceptable; the objective or constraints need a change.';

const str = (args: Args, key: string): string => typeof args[key] === 'string' ? args[key] : '';
const num = (args: Args, key: string, fallback: number): number => typeof args[key] === 'number' ? args[key] : fallback;
const msg = (err: unknown): string => err instanceof Error ? err.message : String(err);

const readCurrent = async (target: string): Promise<string | undefined> => {
  const info = await lstat(target).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; return undefined; });
  if (!info) return undefined;
  if (!info.isFile() || info.size > MAX_FILE) throw new Error('propose requires a regular file of at most 2MB.');
  return readFile(target, 'utf8');
};

const summary = (c: Candidate): CandidateSummary => ({ label: c.label, valid: c.valid, bytes: c.bytes, ...(c.reason === undefined ? {} : { reason: c.reason }) });
const line = (c: Candidate): string => c.valid ? `${c.label} valid ${c.bytes} bytes` : `${c.label} invalid: ${c.reason}`;

const distinctLine = (c: Candidate, others: Candidate[]): string => {
  const lines = c.text.split('\n').map(l => l.trim()).filter(Boolean);
  const seen = others.map(o => new Set(o.text.split('\n').map(l => l.trim())));
  return lines.find(l => seen.every(set => !set.has(l))) ?? lines[0] ?? '';
};

const criterion = (c: Candidate, valid: Candidate[], cur: string | undefined): string => {
  const head = distinctLine(c, valid.filter(o => o !== c));
  if (cur === undefined) return head.slice(0, MAX_CRITERION);
  const hunk = diffLines(cur, c.text);
  const added = hunk.filter(l => l.kind === 'add').length, removed = hunk.filter(l => l.kind === 'remove').length;
  return `+${added}/-${removed} ${head}`.slice(0, MAX_CRITERION);
};

const preview = (c: Candidate, cur: string | undefined): string =>
  (cur === undefined ? c.text : formatHunk(diffLines(cur, c.text)).join('\n')).slice(0, MAX_PREVIEW);

export const proposeTool = (provider: ProposalProvider, registry: AstRegistry): Tool => ({
  name: 'propose', effect: 'write',
  description: 'Ask the generation model for candidate content, filter it, then select one candidate or reject all. Use for open-ended synthesis a bounded grammar cannot produce.',
  fields: {
    kind: { type: 'enum', choices: { file: 'Complete file content written to path.', text: 'Free text returned as output.' }, description: 'What the candidates are.' },
    objective: { type: 'string', description: 'What the content must accomplish.' },
    constraints: { type: 'string', allowEmpty: true, description: 'Hard requirements on the content: interfaces, names, style, forbidden constructs. Empty means none.' },
    count: { type: 'number', min: 1, max: 5, default: 3, description: 'Number of candidates to generate. Empty means 3.' },
    path: { type: 'string', allowEmpty: true, description: 'Destination file path for kind=file. Empty for kind=text.' },
  },
  async execute(args: Args, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.select) throw new Error('propose needs a host that can select');
    if (ctx.proposals && ctx.proposals.used >= ctx.proposals.max) return { ok: false, output: 'proposal budget exhausted; use write_file or edit_file' };
    const kind = str(args, 'kind');
    if (kind !== 'file' && kind !== 'text') throw new Error('kind must be file or text.');
    const path = str(args, 'path');
    if (kind === 'file' && !path) throw new Error('path is required for file candidates');
    const target = kind === 'file' ? await ctx.resolvePath(path) : undefined;
    const cur = target === undefined ? undefined : await readCurrent(target);
    const count = num(args, 'count', 3);
    const req: ProposalRequest = {
      kind, objective: str(args, 'objective'), constraints: str(args, 'constraints'), count,
      ...(kind === 'file' ? { path } : {}), ...(cur === undefined ? {} : { current: cur }),
    };
    if (ctx.proposals) ctx.proposals.used++;
    const completions: Array<Completion | { error: string }> = await provider.generate(req, ctx.signal)
      .catch((err: unknown) => Array.from({ length: count }, () => ({ error: msg(err) })));
    ctx.signal.throwIfAborted();
    const candidates = await validateCandidates(req, completions, registry, ctx.signal);
    const head = [`provider=${provider.id} model=${provider.model}`, ...candidates.map(line)];
    const data: Record<string, unknown> = { provider: provider.id, model: provider.model, kind, ...(kind === 'file' ? { path } : {}), candidates: candidates.map(summary) };
    const valid = candidates.filter(c => c.valid);
    if (!valid.length) return { ok: false, output: [...head, 'no valid candidate'].join('\n'), data };
    const criteria = { ...Object.fromEntries(valid.map(c => [c.label, criterion(c, valid, cur)])), reject: REJECT };
    const extra = {
      field: 'candidate', generation: { phase: 'propose', slot: 'select' },
      candidates: candidates.map(c => ({ ...summary(c), ...(c.valid ? { preview: preview(c, cur) } : {}) })),
    };
    const { choice, confidence } = await ctx.select(INSTRUCTION, criteria, extra);
    if (choice === 'reject') return { ok: false, output: [...head, 'rejected all'].join('\n'), data };
    const chosen = valid.find(c => c.label === choice);
    if (!chosen) throw new Error(`select returned an unknown candidate: ${choice}`);
    const selected = `selected ${chosen.label} ${confidence.toFixed(2)}`;
    const picked = { ...data, selected: chosen.label, confidence };
    if (target === undefined) return { ok: true, output: [...head, selected, '', chosen.text].join('\n'), data: picked };
    await atomicWrite(target, chosen.text, ctx.signal);
    return { ok: true, output: [...head, selected].join('\n'), data: { ...picked, hunk: diffLines(cur ?? '', chosen.text).slice(0, MAX_HUNK) } };
  },
});
