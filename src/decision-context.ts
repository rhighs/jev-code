export const PENDING = '__jev_pending__';

export interface ContextPart {
  key: string;
  value: unknown;
  required?: boolean;
  shrink?: (value: unknown, level: number) => unknown;
}

const radii = [40, 20, 10, 4, 2];

export function windowSource(value: unknown, level: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const radius = radii[level - 1];
  if (radius === undefined) return undefined;
  const lines = value.replace(/\n$/, '').split('\n');
  const at = Math.max(0, lines.findIndex(line => line.includes(PENDING)));
  let head = 0;
  while (head < lines.length && head < 6 && /^(?:import|from)\b/.test(lines[head]!)) head++;
  const start = Math.max(head, at - radius), end = Math.min(lines.length, at + radius + 1);
  const out = [...lines.slice(0, head)];
  if (start > head) out.push(`# ... ${start - head} lines omitted`);
  out.push(...lines.slice(start, end));
  if (end < lines.length) out.push(`# ... ${lines.length - end} lines omitted`);
  return out.join('\n') + '\n';
}

export function buildDecisionContext(parts: ContextPart[], measure: (values: Record<string, unknown>) => number, cap: number): { values: Record<string, unknown>; trimmed: string[] } {
  const values: Record<string, unknown> = Object.fromEntries(parts.map(part => [part.key, part.value]));
  const trimmed: string[] = [];
  if (measure(values) <= cap) return { values, trimmed };
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (part.required) continue;
    if (part.shrink) {
      let shrunk = false;
      for (let level = 1; ; level++) {
        const next = part.shrink(part.value, level);
        if (next === undefined) break;
        if (next === values[part.key]) continue;
        values[part.key] = next;
        shrunk = true;
        if (measure(values) <= cap) break;
      }
      if (shrunk) trimmed.push(part.key);
    } else {
      delete values[part.key];
      trimmed.push(part.key);
    }
    if (measure(values) <= cap) return { values, trimmed };
  }
  return { values, trimmed };
}

/**
 * Byte cap for the uncapped decision paths (action select, completion check, field choices, plan
 * selects). The value mirrors MAX_GRID_REQUEST_BYTES in scored-grid.ts: bytes are the token proxy,
 * and 24k bytes keeps a request well inside Jev's 32k-token budget without touching the AST/grid caps.
 */
export const MAX_DECISION_REQUEST_BYTES = 24_000;

/** Per-key clamps applied when a decision state exceeds the byte cap. */
export interface DecisionCompaction {
  /** Clips the carried task text: the prompt, the newest updates, and each update's length. */
  task?: { prompt: number; updates: number; keep?: number };
  history?: { keep: number; output: number };
  recent?: { keep: number; args: number; output: number; data?: number };
  observations?: { keep: number; args: number; output: number; data?: number };
  conversation?: { prompt: number; summary: number };
  plan?: number;
}

export interface DecisionFit {
  state: Record<string, unknown>;
  bytes: number;
  cap: number;
  /** Keys the compaction changed, in application order. */
  trimmed: string[];
  overBudget: boolean;
}

/** Action/field/plan profile: bounded records with clipped outputs and result data. */
export const DECISION_COMPACTION: DecisionCompaction = {
  history: { keep: 12, output: 200 },
  recent: { keep: 4, args: 512, output: 800, data: 512 },
  observations: { keep: 4, args: 512, output: 800, data: 512 },
  conversation: { prompt: 600, summary: 800 },
  plan: 1000,
};

/**
 * Completion-check profile: keeps more evidence and never clips `result.data`, the observed
 * evidence the verdict is made from. An over-budget completion is rejected as a size failure
 * rather than judged on trimmed evidence.
 */
export const COMPLETION_COMPACTION: DecisionCompaction = {
  history: { keep: 16, output: 200 },
  recent: { keep: 8, args: 1024, output: 2000 },
  observations: { keep: 8, args: 1024, output: 2000 },
  conversation: { prompt: 600, summary: 800 },
  plan: 1000,
};

/**
 * Action-select profile: the task text rides in both the action state and the instruction built
 * from it, so a long but legal prompt can exceed the cap on its own. The action decision degrades
 * by clipping the carried task text instead of ending the run; the completion check and the
 * field/plan selects keep their stricter profiles (an over-budget completion stays a size failure).
 */
export const ACTION_COMPACTION: DecisionCompaction = {
  ...DECISION_COMPACTION,
  task: { prompt: 4000, updates: 2000, keep: 8 },
};

/**
 * Harder compaction applied once when a single decision request is rejected by the platform's
 * token budget (`max_tokens_exceeded`). The state shape is preserved, so the question keeps its
 * meaning; only the context keys the standard profiles already bound are trimmed further.
 */
export const RETRY_COMPACTION: DecisionCompaction = {
  history: { keep: 4, output: 120 },
  recent: { keep: 2, args: 256, output: 400, data: 256 },
  observations: { keep: 2, args: 256, output: 400, data: 256 },
  conversation: { prompt: 200, summary: 300 },
  plan: 400,
};

/**
 * Retry-state builder for the facade's `max_tokens_exceeded` recovery: one harder compaction pass
 * over the state that was rejected. The state shape is preserved, so the question keeps its
 * meaning; when nothing can be trimmed the state is returned unchanged and the single retry is
 * still attempted.
 */
export const compactRetryState = (state: Record<string, unknown>): Record<string, unknown> =>
  compactDecisionState(state, RETRY_COMPACTION).state;

/** Request bytes for one Choice question, matching the payload DecisionSession.choose sends. */
export function decisionChoiceBytes(state: unknown, instructions: string, criteria: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify({ state, questions: { selection: { type: 'choice', instructions, criteria } } }));
}

/** Request bytes for one Noul question, matching the payload DecisionSession.probability sends. */
export function decisionProbabilityBytes(state: unknown, instructions: string): number {
  return Buffer.byteLength(JSON.stringify({ state, questions: { verdict: { type: 'noul', instructions } } }));
}

const clipText = (value: unknown, limit: number): unknown =>
  typeof value === 'string' && value.length > limit ? `${value.slice(0, limit)}\n[context clipped]` : value;

const clipShape = (value: unknown, limit: number, depth = 0): unknown => {
  if (typeof value === 'string') return clipText(value, limit);
  if (Array.isArray(value)) return value.map(item => clipShape(item, limit, depth + 1));
  if (typeof value === 'object' && value !== null && depth < 6) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clipShape(item, limit, depth + 1)]));
  }
  return value;
};

/** One-line history records: turn, tool, outcome and a clipped output, with older entries dropped. */
const oneLineRecords = (records: readonly unknown[], output: number): Array<Record<string, unknown>> =>
  records.map(record => {
    const value = record as Record<string, unknown>;
    const result = value.result as Record<string, unknown> | undefined;
    return { turn: value.turn, tool: value.tool, ok: result?.ok ?? value.ok, output: clipText(result?.output ?? value.output, output) };
  });

const boundedRecords = (records: readonly unknown[], options: { args: number; output: number; data?: number }): Array<Record<string, unknown>> =>
  records.map(record => {
    const value = record as Record<string, unknown>;
    const result = (value.result ?? {}) as Record<string, unknown>;
    return {
      ...value,
      args: clipShape(value.args ?? {}, options.args),
      result: {
        ...result,
        ...(typeof result.output === 'string' ? { output: clipText(result.output, options.output) } : {}),
        ...(options.data !== undefined && result.data !== undefined ? { data: clipShape(result.data, options.data) } : {}),
      },
    };
  });

/** Apply one compaction pass to a decision state and report the keys that changed. */
export function compactDecisionState(state: Record<string, unknown>, profile: DecisionCompaction = DECISION_COMPACTION): { state: Record<string, unknown>; trimmed: string[] } {
  const compacted: Record<string, unknown> = { ...state };
  const trimmed: string[] = [];
  const replace = (key: string, next: unknown): void => {
    if (JSON.stringify(state[key]) === JSON.stringify(next)) return;
    compacted[key] = next;
    trimmed.push(key);
  };
  const taskProfile = profile.task;
  if (taskProfile !== undefined && typeof state.task === 'object' && state.task !== null && !Array.isArray(state.task)) {
    const task = state.task as Record<string, unknown>;
    const next: Record<string, unknown> = { ...task };
    if (typeof task.prompt === 'string') next.prompt = clipText(task.prompt, taskProfile.prompt);
    if (Array.isArray(task.updates)) {
      const keep = taskProfile.keep ?? task.updates.length;
      next.updates = (task.updates as readonly unknown[]).slice(-keep).map(update => clipText(update, taskProfile.updates));
    }
    replace('task', next);
  }
  if (profile.history !== undefined && Array.isArray(state.history)) {
    replace('history', oneLineRecords((state.history as readonly unknown[]).slice(-profile.history.keep), profile.history.output));
  }
  if (profile.recent !== undefined && Array.isArray(state.recent)) {
    replace('recent', boundedRecords((state.recent as readonly unknown[]).slice(-profile.recent.keep), profile.recent));
  }
  if (profile.observations !== undefined && Array.isArray(state.observations)) {
    replace('observations', boundedRecords((state.observations as readonly unknown[]).slice(-profile.observations.keep), profile.observations));
  }
  const conversation = profile.conversation;
  if (conversation !== undefined && Array.isArray(state.conversation)) {
    replace('conversation', (state.conversation as readonly unknown[]).map(entry => {
      const value = entry as Record<string, unknown>;
      return { ...value, prompt: clipText(value.prompt, conversation.prompt), summary: clipText(value.summary, conversation.summary) };
    }));
  }
  if (profile.plan !== undefined) replace('plan', clipText(state.plan, profile.plan));
  return { state: compacted, trimmed };
}

/**
 * Fit a decision state under the byte cap: return it unchanged when it already fits; otherwise
 * compact history/recent/observations/conversation/plan once and re-measure. `measure` must compute
 * the byte size of the request that would be built from the candidate state.
 */
export function fitDecisionState(
  state: Record<string, unknown>,
  measure: (state: Record<string, unknown>) => number,
  cap: number = MAX_DECISION_REQUEST_BYTES,
  profile: DecisionCompaction = DECISION_COMPACTION,
): DecisionFit {
  const original = measure(state);
  if (original <= cap) return { state, bytes: original, cap, trimmed: [], overBudget: false };
  const compacted = compactDecisionState(state, profile);
  const bytes = measure(compacted.state);
  return { state: compacted.state, bytes, cap, trimmed: compacted.trimmed, overBudget: bytes > cap };
}

export interface AstStateInput { objective: string; context: Record<string, unknown>; preview: string; core: Record<string, unknown>; questions: unknown; cap: number }

export function astDecisionState({ objective, context, preview, core, questions, cap }: AstStateInput): Record<string, unknown> {
  const assemble = (values: Record<string, unknown>): Record<string, unknown> => ({
    task: values.task, ...(values.recent === undefined ? {} : { recent: values.recent }), ...(values.plan === undefined ? {} : { plan: values.plan }),
    generation: { ...core, partialSource: values.source, ...(values.trimmed === undefined ? {} : { trimmed: values.trimmed }) },
  });
  const { values, trimmed } = buildDecisionContext([
    { key: 'task', value: { prompt: objective }, required: true },
    { key: 'core', value: core, required: true },
    { key: 'source', value: preview, shrink: windowSource },
    { key: 'recent', value: context.recent ?? [] },
    ...(typeof context.plan === 'string' && context.plan ? [{ key: 'plan', value: context.plan }] : []),
  ], parts => Buffer.byteLength(JSON.stringify({ state: assemble(parts), questions })), cap);
  return assemble(trimmed.length ? { ...values, trimmed } : values);
}
