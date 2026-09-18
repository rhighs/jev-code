import { formatHunk, type DiffLine } from './diff.js';
import { displayText, fitLine, highlightCode, paint } from './terminal-style.js';
import { formatDuration } from './timing.js';
import { OUTPUT_LINES, decisionHead, decisionStrip, pct, type Body, type Decision, type Item, type Live, type ToolItem, type ToolStatus, type TranscriptState } from './transcript.js';

export interface RenderOpts { color: boolean; width?: number }
type Summary = Extract<Item, { kind: 'summary' }>;

const GLYPH: Record<ToolStatus, string> = { pending: '○', awaiting: '?', generating: '◔', running: '◐', done: '✓', failed: '✗', denied: '⊘' };
const LABEL: Record<ToolStatus, string> = { pending: 'pending', awaiting: 'needs approval', generating: 'generating', running: 'running', done: '', failed: 'failed', denied: 'denied' };
const CODE: Record<ToolStatus, number> = { pending: 2, awaiting: 33, generating: 36, running: 36, done: 32, failed: 31, denied: 31 };
const DIFF: Record<DiffLine['kind'], number> = { context: 0, remove: 31, add: 32, skip: 2 };
const LIVE_LINES = 8;

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
const fit = (text: string, opts: RenderOpts, used = 0): string => opts.width === undefined ? displayText(text) : fitLine(text, Math.max(2, opts.width - used));
const dim = (text: string, opts: RenderOpts): string => paint(text, 2, opts.color);
const bar = (text: string, opts: RenderOpts): string => `  ${dim('│', opts)} ${text}`;

const header = (card: ToolItem, opts: RenderOpts): string => {
  const parts = [LABEL[card.status], card.exitCode === undefined ? '' : `exit ${card.exitCode}`, card.durationMs === undefined ? '' : formatDuration(card.durationMs), `${card.requests} req`].filter(Boolean);
  return paint(fit(`${GLYPH[card.status]} ${card.tool}${card.target ? ` ${card.target}` : ''} · ${parts.join(' · ')}`, opts), CODE[card.status], opts.color);
};

const numbered = (lines: string[], first: number, opts: RenderOpts): string[] => lines.map((line, i) => {
  const prefix = `${String(first + i).padStart(3)}  `;
  return bar(dim(prefix, opts) + highlightCode(fit(line, opts, prefix.length + 4), opts.color), opts);
});

const renderBody = (body: Body, opts: RenderOpts): string[] => {
  switch (body.kind) {
    case 'source': return [...numbered(body.lines, 1, opts), ...(body.remaining ? [bar(dim(fit(`… ${plural(body.remaining, 'more line')} · ${body.hint}`, opts, 4), opts), opts)] : [])];
    case 'diff': return formatHunk(body.hunk).map((text, i) => bar(paint(fit(text, opts, 4), DIFF[body.hunk[i]!.kind], opts.color), opts));
    case 'output': return [...body.lines.map(line => bar(fit(line, opts, 4), opts)), ...(body.remaining ? [bar(dim(`… ${plural(body.remaining, 'more line')}`, opts), opts)] : [])];
    case 'paths': return [...body.paths.map(path => bar(fit(path, opts, 4), opts)), ...(body.remaining ? [bar(dim(`… ${plural(body.remaining, 'more file')}`, opts), opts)] : [])];
  }
};

const renderDecision = (d: Decision): string => {
  const alt = d.options.slice(1).map(o => `${o.label} ${pct(o.probability)}`).join(', ');
  const [head, ...rest] = decisionHead(d);
  return [`${d.unit ? `${d.unit} · ` : ''}${head}`, ...rest, alt ? `alt ${alt}` : ''].filter(Boolean).join(' · ');
};

export function renderItem(item: Item, opts: RenderOpts): string[] {
  switch (item.kind) {
    case 'prompt': { const [first = '', ...rest] = item.text.split('\n'); return [paint(fit(`› ${first}`, opts), 1, opts.color), ...rest.map(line => fit(`  ${line}`, opts))]; }
    case 'tool': return [header(item, opts), ...(item.body ? renderBody(item.body, opts) : [])];
    case 'turn': { const plan = item.plan.split('\n')[0]; return [dim(fit(`── turn ${item.turn} · ${plural(item.files, 'file')}${plan ? ` · plan: ${plan}` : ''}`, opts), opts)]; }
    case 'update': return [paint(fit(`↳ update · ${item.text}`, opts), 36, opts.color)];
    case 'trace': return [fit(item.decisions.length ? `trace · ${plural(item.decisions.length, 'decision')}` : 'trace · no decisions', opts), ...item.decisions.map(d => `  ${paint(fit(renderDecision(d), opts, 2), d.lowConfidence ? 33 : 0, opts.color)}`)];
    case 'summary': return renderSummary(item, opts);
  }
}

export function renderSummary(summary: Summary, opts: RenderOpts = { color: false }): string[] {
  const { limits } = summary;
  const budget = [formatDuration(summary.durationMs), limits ? `${summary.turns}/${limits.turns} turns` : plural(summary.turns, 'turn'),
    limits ? `${summary.requests}/${limits.requests} requests` : plural(summary.requests, 'request'), `${summary.usage.inputTokens + summary.usage.outputTokens} tokens`, `run ${summary.runId}`];
  return [paint(`[${summary.status}]`, summary.status === 'completed' ? 32 : 33, opts.color),
    ...summary.facts.map(fact => `  ${fit(fact, opts, 2)}`),
    ...(summary.omitted ? [`  ${plural(summary.omitted, 'more outcome')} in the run log.`] : []),
    ...(summary.reason ? summary.reason.split('\n').map(line => `  ${fit(line, opts, 2)}`) : []),
    dim(fit(budget.join(' · '), opts), opts)];
}

export function renderLive(live: Live, state: TranscriptState, opts: RenderOpts, max = LIVE_LINES): string[] {
  const strip = `  ${fit(decisionStrip(state), opts, 2)}`;
  if (live.card.status === 'awaiting') return [...renderItem(live.card, { color: opts.color }), strip];
  if (max === 0) return [strip];
  const card: ToolItem = { ...live.card, target: live.path ?? live.card.target };
  if (live.card.status === 'running') {
    const out = live.output === '' ? [] : live.output.replace(/\n$/, '').split('\n').slice(-Math.min(max, OUTPUT_LINES));
    return [header(card, opts), ...out.map(line => bar(fit(line, opts, 4), opts)), strip];
  }
  const all = live.source === undefined ? [] : live.source.replace(/\n$/, '').split('\n');
  const tail = all.slice(-max);
  return [header(card, opts), ...numbered(tail, all.length - tail.length + 1, opts), ...(live.search ? [`  ${fit(`search · ${live.search}`, opts, 2)}`] : []), strip];
}

export const renderStep = (live: Live, search = false): string =>
  `  ${search ? `search · ${live.search ?? ''}` : `${live.unit ? `${live.unit} · ` : ''}${live.slot ?? ''} → ${live.production ?? ''}`}`;
