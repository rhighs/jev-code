import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildDecisionContext } from './decision-context.js';
import { Decisions } from './decisions.js';
import { MAX_GRID_REQUEST_BYTES } from './scored-grid.js';
import type { DecisionEventData, DecisionProvider, HarnessEvent } from './types.js';

export interface DecideResult { stdout: string; stderr: string; code: number }
export interface SpecEntry { question?: string; choices?: string[]; true?: string; score?: string; threshold?: number }

const FAIL = 125;
const MAX_CHOICES = 100;
const LEVELS = ['does not satisfy', 'partially satisfies', 'mostly satisfies', 'fully satisfies'];
const decoder = new TextDecoder();

const shrinkText = (value: unknown, level: number): unknown => {
  const keep = MAX_GRID_REQUEST_BYTES - level * 1024;
  if (typeof value !== 'string' || keep <= 0) return undefined;
  return decoder.decode(Buffer.from(value).subarray(0, keep), { stream: true });
};

const parseLabels = (raw: string): string[] => {
  const labels = raw.split(',').map(s => s.trim());
  if (labels.some(l => !l)) throw new Error('--choices labels must be non-empty.');
  if (new Set(labels).size !== labels.length) throw new Error('--choices labels must be unique.');
  if (labels.length < 2 || labels.length > MAX_CHOICES) throw new Error(`--choices needs 2 to ${MAX_CHOICES} labels.`);
  return labels;
};

const parseThreshold = (raw: unknown, flag: string): number => {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${flag} must be a number between 0 and 1.`);
  return value;
};

const parseSpec = (text: string): SpecEntry[] => {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('--spec must be a non-empty JSON array.');
  return parsed.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`--spec entry ${i} must be an object.`);
    const e = entry as Record<string, unknown>;
    const modes = ['choices', 'true', 'score'].filter(k => e[k] !== undefined);
    if (modes.length !== 1) throw new Error(`--spec entry ${i} needs exactly one of choices, true, score.`);
    const out: SpecEntry = {};
    if (e.choices !== undefined) {
      if (!Array.isArray(e.choices) || e.choices.some(c => typeof c !== 'string') || typeof e.question !== 'string' || !e.question) throw new Error(`--spec entry ${i} needs a question and a string array of choices.`);
      out.question = e.question;
      out.choices = parseLabels((e.choices as string[]).join(','));
    }
    if (e.true !== undefined) { if (typeof e.true !== 'string' || !e.true) throw new Error(`--spec entry ${i}: true must be a statement.`); out.true = e.true; }
    if (e.score !== undefined) { if (typeof e.score !== 'string' || !e.score) throw new Error(`--spec entry ${i}: score must be a criteria string.`); out.score = e.score; }
    if (e.threshold !== undefined) out.threshold = parseThreshold(e.threshold, `--spec entry ${i} threshold`);
    return out;
  });
};

interface Asker {
  choose(input: string, question: string, labels: string[]): Promise<{ label: string; data: DecisionEventData }>;
  probability(input: string, statement: string): Promise<{ value: number; data: DecisionEventData }>;
  score(input: string, criteria: string): Promise<{ expected: number; data: DecisionEventData }>;
}

const asker = (provider: DecisionProvider, budget: number): Asker => {
  const root = new Decisions(provider, budget, new AbortController().signal);
  const observed = <T>(fn: (d: Decisions) => Promise<T>): Promise<[T, DecisionEventData]> => {
    let data: DecisionEventData | undefined;
    return fn(root.observe(async d => { data = d; })).then(value => {
      if (!data) throw new Error('Jev returned no decision.');
      return [value, { ...data, field: 'stdin' }];
    });
  };
  return {
    choose: async (input, question, labels) => {
      const [label, data] = await observed(d => d.choose({ input }, question, Object.fromEntries(labels.map(l => [l, l]))));
      return { label, data };
    },
    probability: async (input, statement) => {
      const [value, data] = await observed(d => d.probability({ input }, `Is the following statement true of the input? ${statement}`));
      return { value, data };
    },
    score: async (input, criteria) => {
      const [{ expected }, data] = await observed(d => d.score({ input }, `Rate how well the input satisfies the criteria: ${criteria}`, LEVELS.map(l => `${l} "${criteria}"`)));
      return { expected, data };
    },
  };
};

const fixed = (n: number): string => n.toFixed(2);

export async function runDecide(argv: string[], input: string, provider: DecisionProvider): Promise<DecideResult> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const out: string[] = [], err: string[] = [];
  const event = (data: DecisionEventData, extra: Record<string, unknown> = {}): string => {
    const e: HarnessEvent = { type: 'decision', runId, timestamp: new Date().toISOString(), elapsedMs: Date.now() - startedAt, turn: 0, data };
    return JSON.stringify({ ...e, ...extra }) + '\n';
  };
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      choices: { type: 'string' }, true: { type: 'string' }, score: { type: 'string' }, spec: { type: 'string' },
      threshold: { type: 'string' }, lines: { type: 'boolean' }, json: { type: 'boolean' },
    } });
    const modes = (['choices', 'true', 'score', 'spec'] as const).filter(k => values[k] !== undefined);
    if (modes.length !== 1) throw new Error('Use exactly one of "<question>" --choices a,b, --true "<statement>", --score "<criteria>", or --spec <file.json>.');
    const mode = modes[0]!;
    if (mode === 'choices' ? positionals.length !== 1 || !positionals[0] : positionals.length) throw new Error(mode === 'choices' ? '--choices needs one question.' : `--${mode} takes no positional question.`);
    if (values.lines && mode !== 'true' && mode !== 'score') throw new Error('--lines works with --true or --score.');
    if (values.threshold !== undefined && mode !== 'true') throw new Error('--threshold works with --true.');
    const threshold = values.threshold === undefined ? 0.5 : parseThreshold(values.threshold, '--threshold');
    const spec = mode === 'spec' ? parseSpec(await readFile(resolve(values.spec!), 'utf8')) : [];
    if (mode === 'true' && !values.true) throw new Error('--true needs a statement.');
    if (mode === 'score' && !values.score) throw new Error('--score needs a criteria.');

    const measure = (parts: Record<string, unknown>): number => Buffer.byteLength(JSON.stringify({ state: parts, question: positionals[0] ?? values.true ?? values.score ?? '' }));
    const { values: ctx, trimmed } = buildDecisionContext([{ key: 'input', value: input, shrink: shrinkText }], measure, MAX_GRID_REQUEST_BYTES);
    const text = String(ctx.input ?? '');
    if (trimmed.length) err.push(`input truncated to ${Buffer.byteLength(text)} bytes\n`);
    const lines = values.lines ? text.split('\n').filter(l => l.trim()) : [];
    const count = values.lines ? lines.length : mode === 'spec' ? spec.length : 1;
    const ask = asker(provider, count + 2);
    let code = 0;

    if (values.lines) {
      const ranked = (await Promise.all(lines.map(async line => {
        const res = mode === 'true' ? await ask.probability(line, values.true!) : await ask.score(line, values.score!);
        return { line, value: 'value' in res ? res.value : res.expected, data: res.data };
      }))).sort((a, b) => b.value - a.value)
        .filter(r => mode !== 'true' || values.threshold === undefined || r.value >= threshold);
      for (const r of ranked) out.push(values.json ? event(r.data, { line: r.line }) : `${fixed(r.value)}\t${r.line}\n`);
    } else if (mode === 'spec') {
      const answers = await Promise.all(spec.map(async entry => {
        if (entry.choices) {
          const { label, data } = await ask.choose(text, entry.question!, entry.choices);
          return { data, line: { question: entry.question, choice: label, confidence: data.confidence, options: data.options } };
        }
        if (entry.true !== undefined) {
          const { value, data } = await ask.probability(text, entry.true);
          return { data, line: { question: entry.true, probability: value, ...(entry.threshold === undefined ? {} : { choice: String(value >= entry.threshold) }) } };
        }
        const { expected, data } = await ask.score(text, entry.score!);
        return { data, line: { question: entry.score, score: expected, options: data.options } };
      }));
      for (const a of answers) out.push(values.json ? event(a.data) : JSON.stringify(a.line) + '\n');
    } else if (mode === 'choices') {
      const labels = parseLabels(values.choices!);
      const { label, data } = await ask.choose(text, positionals[0]!, labels);
      out.push(values.json ? event(data) : `${label} ${fixed(data.confidence!)}\n`);
      code = labels.indexOf(label);
    } else if (mode === 'true') {
      const { value, data } = await ask.probability(text, values.true!);
      out.push(values.json ? event(data) : `${fixed(value)}\n`);
      code = value >= threshold ? 0 : 1;
    } else {
      const { expected, data } = await ask.score(text, values.score!);
      out.push(values.json ? event(data) : `${fixed(expected)} ${LEVELS[Math.round(expected)]}\n`);
    }
    return { stdout: out.join(''), stderr: err.join(''), code };
  } catch (error) {
    err.push(`decide: ${error instanceof Error ? error.message : String(error)}\n`);
    return { stdout: '', stderr: err.join(''), code: FAIL };
  }
}
