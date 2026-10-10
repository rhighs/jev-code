import { DecisionSession, createDecisionSession, isNearTie, waveFailureKind } from './sdk/decisions.js';
import { RunResources, type RunLimits } from './sdk/resources.js';
import { DecisionError, LimitError, type DecisionAlternative, type DecisionProvider, type DecisionResult, type JsonObject, type WaveChoice, type WaveDecisionResult, type WaveQuestion } from './sdk/types.js';
import { defaultRunContext, mergeIdentity, type DecisionIdentity, type DecisionKind, type PathChoice, type PathDecisionRequest, type RunContext } from './run-context.js';
import type { DecisionEventData } from './types.js';

export type State = Record<string, unknown>;

/**
 * Caller-supplied retry-state builder for the `max_tokens_exceeded` recovery: it returns the
 * compacted state used for the single retry. An already-minimal state is returned unchanged, in
 * which case the retry is still attempted once (a byte-proxy mismatch can be transient).
 * Harness/generation call sites pass a decision-context builder.
 */
export type RetryStateBuilder = (state: State) => State;

/**
 * Byte cap for one wave request. Mirrors MAX_GRID_REQUEST_BYTES: bytes are the token proxy, and a
 * wave is pre-split into one request per part before sending, so no part exceeds the cap.
 */
export const MAX_WAVE_REQUEST_BYTES = 24_000;

/**
 * One question inside a wave. `criteria` must not depend on any sibling answer (the dependency
 * rule); questions with fewer than two labels are resolved host-side and never enter a request.
 */
export interface WaveQuestionSpec {
  instruction: string;
  criteria: Record<string, string>;
  /** Slot recorded on the event and path entry; defaults to the wave key. */
  slot?: string;
  kind?: DecisionKind;
  /** Per-question identity override merged over the state-derived identity. */
  identity?: Partial<DecisionIdentity>;
  /** Criterion text of the chosen label and the full map, for runtime-failure attribution. */
  answer?: string;
  answers?: Record<string, string>;
}

export interface WaveRequest {
  /** Attempt scope for the recorded path entries. */
  scope: string;
  context?: RunContext;
  kind?: DecisionKind;
  /** Harder state for one `max_tokens_exceeded` retry of a wave part. */
  retryState?: RetryStateBuilder;
  /** Journal hook: a question isolated by bisection is asked singly instead. */
  onSkip?: (question: string, detail: string) => void | Promise<void>;
}

/** One answered wave question; `decisionId` is absent when the question was host-derived. */
export interface WaveAnswer {
  choice: string;
  decisionId?: number;
  alternatives: DecisionAlternative[];
  nearTie: boolean;
}

/** Request bytes for a wave, matching the payload DecisionSession.chooseWave sends. */
export const waveRequestBytes = (state: unknown, questions: Record<string, WaveQuestionSpec>): number =>
  Buffer.byteLength(JSON.stringify({ state, questions: Object.fromEntries(Object.entries(questions).map(([key, spec]) => [key,
    { type: 'choice', instructions: spec.instruction, criteria: spec.criteria }])) }));

/** Worst-case request count for a wave: every question asked singly plus the bisection overhead. */
const waveWorstCase = (count: number): number => count + Math.ceil(Math.log2(Math.max(1, count)));

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

const projectJson = (value: unknown, ancestors: Set<object>): unknown => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return value;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  ancestors.add(value);
  const projected = Array.isArray(value)
    ? value.map(item => projectJson(item, ancestors) ?? null)
    : Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const normalized = projectJson(item, ancestors);
      return normalized === undefined ? [] : [[key, normalized]];
    }));
  ancestors.delete(value);
  return projected;
};

/** Omit optional undefined properties before the strict SDK transport validation. */
export const jsonState = (state: State): JsonObject => projectJson(state, new Set()) as JsonObject;

const identity = (state: State): Pick<DecisionEventData, 'field' | 'phase' | 'slot' | 'unit' | 'candidate'> => {
  const gen = (state.generation && typeof state.generation === 'object' ? state.generation : {}) as Record<string, unknown>;
  const field = typeof gen.field === 'string' ? gen.field : typeof state.field === 'string' ? state.field : undefined;
  return {
    ...(field === undefined ? {} : { field }),
    ...(typeof gen.phase === 'string' ? { phase: gen.phase } : {}),
    ...(typeof gen.slot === 'string' ? { slot: gen.slot } : {}),
    ...(typeof gen.unit === 'string' ? { unit: gen.unit } : {}),
    ...(typeof gen.candidate === 'number' ? { candidate: gen.candidate } : {}),
  };
};

export class Decisions {
  get requests(): number { return this.resources.snapshot().used.decisions; }
  get exhausted(): boolean { return this.requests >= this.maxRequests; }
  get usage(): { inputTokens: number; outputTokens: number } { return this.resources.snapshot().usage; }
  readonly signal: AbortSignal;
  /** Run-scoped generation state shared by this facade and every fork. */
  readonly runContext: RunContext;

  private readonly resources: RunResources;
  private readonly session: DecisionSession;

  constructor(
    private readonly provider: DecisionProvider,
    private readonly maxRequests: number,
    signal: AbortSignal,
    private readonly onDecision: (data: DecisionEventData) => Promise<void> = async () => {},
    concurrency = 4,
    resources?: RunResources,
    context?: RunContext,
    initial?: Partial<RunLimits>,
  ) {
    this.runContext = context ?? defaultRunContext();
    this.resources = resources ?? new RunResources({ limits: { decisions: maxRequests }, signal, concurrency, ...(initial === undefined ? {} : { initial }) });
    this.session = createDecisionSession(provider, this.resources, undefined, undefined, this.runContext);
    this.signal = this.resources.signal;
  }

  fork(signal: AbortSignal): Decisions {
    return new Decisions(this.provider, this.maxRequests, signal, this.onDecision, 1, this.resources.fork(signal), this.runContext);
  }

  observe(onDecision: (data: DecisionEventData) => Promise<void>): Decisions {
    return new Decisions(this.provider, this.maxRequests, this.signal, onDecision, 1, this.resources, this.runContext);
  }

  /** Public SDK session sharing this facade's budget, cancellation, usage, and event observer. */
  publicSession(state: State | (() => State)): DecisionSession {
    return this.observed(state);
  }

  assertRequestBudget(count: number): void {
    try { this.resources.assertAvailable('decisions', count); }
    catch (error) {
      if (error instanceof LimitError) throw new LimitError(`Request budget exhausted (${this.maxRequests}).`, {
        cause: error,
        ...(error.evidence === undefined ? {} : { evidence: error.evidence }),
      });
      throw error;
    }
  }

  private observed(state: State | (() => State)): DecisionSession {
    return this.session.observe(async (result: DecisionResult) => {
      const currentState = typeof state === 'function' ? state() : state;
      if (result.type === 'choice') {
        await this.onDecision({ choice: result.value, confidence: result.metadata.confidence, model: result.metadata.model,
          options: [...result.metadata.alternatives], ...identity(currentState) });
      } else if (result.type === 'probability') {
        await this.onDecision({ probability: result.value, model: result.metadata.model, ...identity(currentState) });
      } else if (result.type === 'score') {
        await this.onDecision({ choice: String(Math.round(result.value.expected)), confidence: result.metadata.confidence,
          model: result.metadata.model, options: [...result.metadata.alternatives], ...identity(currentState) });
      } else if (result.type === 'many-choice') {
        await this.onDecision({ questions: result.metadata.questions, model: result.metadata.model });
      } else {
        // A raw-session wave result: one event per answered question, all sharing one allocated wave
        // id so transcript accounting counts the single request once. The facade's own chooseWave
        // path emits its richer events (decisionId, wave) and does not pass through here.
        const wave = this.runContext.allocateWaveId();
        for (const [slot, answer] of Object.entries(result.value)) {
          await this.onDecision({ choice: answer.choice, confidence: answer.confidence, model: result.metadata.model,
            options: [...answer.alternatives], ...identity(currentState), slot, wave });
        }
      }
    });
  }

  /**
   * Alternatives-aware choice: records the pick, its retained alternatives, and the canonical
   * near-tie flag in the run context, and attaches `decisionId`/`nearTie` to the decision event.
   * Callers that do not need repair data keep using choose().
   */
  async chooseWithAlternatives(state: State, instructions: string, criteria: Record<string, string>, request: PathDecisionRequest): Promise<PathChoice> {
    const context = request.context ?? this.runContext;
    let captured: PathChoice | undefined;
    const session = this.session.observe(async (result: DecisionResult) => {
      if (result.type !== 'choice') throw new DecisionError('chooseWithAlternatives requires a choice result.');
      const alternatives = [...result.metadata.alternatives];
      const nearTie = isNearTie(alternatives, result.value);
      const decisionId = context.allocateDecisionId();
      captured = { choice: result.value, decisionId, alternatives, nearTie };
      const currentIdentity = mergeIdentity(identity(state), request.identity);
      const answer = request.answer ?? request.answers?.[result.value];
      context.recordDecision(request.scope, {
        decisionId, questionKey: request.questionKey, identity: currentIdentity,
        chosen: result.value, alternatives, nearTie, kind: request.kind,
        ...(answer === undefined ? {} : { answer }),
        ...(request.answers === undefined ? {} : { answers: { ...request.answers } }),
      });
      await this.onDecision({ choice: result.value, confidence: result.metadata.confidence, model: result.metadata.model,
        options: alternatives, decisionId, nearTie, ...currentIdentity });
    });
    await session.choose(jsonState(state), instructions, criteria);
    if (captured === undefined) throw new DecisionError('The choice decision did not report a result.');
    return captured;
  }

  /**
   * Run one single-question decision with `max_tokens_exceeded` recovery: when the platform
   * rejects the request for exceeding its token budget, the caller-supplied builder compacts the
   * state and the decision retries once; a second rejection fails that decision only. The builder
   * receives the same state the failed attempt was built from.
   */
  private async withTokenRecovery<T>(state: State, retryState: RetryStateBuilder | undefined, attempt: (state: State) => Promise<T>): Promise<T> {
    try {
      return await attempt(state);
    } catch (error) {
      if (retryState === undefined || !(error instanceof DecisionError) || !/max_tokens_exceeded/.test(error.message)) throw error;
      this.signal.throwIfAborted();
      return attempt(retryState(state));
    }
  }

  async choose(state: State, instructions: string, criteria: Record<string, string>, retryState?: RetryStateBuilder): Promise<string> {
    return this.withTokenRecovery(state, retryState, async candidate =>
      (await this.observed(candidate).choose(jsonState(candidate), instructions, criteria)).value);
  }

  async probability(state: State, instructions: string, retryState?: RetryStateBuilder): Promise<number> {
    return this.withTokenRecovery(state, retryState, async candidate =>
      (await this.observed(candidate).probability(jsonState(candidate), instructions)).value);
  }

  async score(state: State, instructions: string, levels: string[], retryState?: RetryStateBuilder): Promise<{ expected: number; probabilities: number[] }> {
    return this.withTokenRecovery(state, retryState, async candidate => {
      const result = await this.observed(candidate).score(jsonState(candidate), instructions, levels);
      return { expected: result.value.expected, probabilities: [...result.value.probabilities] };
    });
  }

  /** Parallel positions, each with a scored categorical distribution over characters. */
  async chooseMany(state: State, instructions: Record<string, string>, criteria: Record<string, string>): Promise<Record<string, { choice: string; score: number; probabilities: Record<string, number> }>> {
    try {
      const result = await this.observed(state).chooseMany(jsonState(state), instructions, criteria);
      return result.value;
    } catch (error) {
      const entries = Object.entries(instructions);
      if (!(error instanceof DecisionError) || !/max_tokens_exceeded/.test(error.message) || entries.length < 2) throw error;
      this.signal.throwIfAborted();
      const middle = Math.ceil(entries.length / 2);
      const parts = await Promise.allSettled([
        this.chooseMany(state, Object.fromEntries(entries.slice(0, middle)), criteria),
        this.chooseMany(state, Object.fromEntries(entries.slice(middle)), criteria),
      ]);
      for (const part of parts) if (part.status === 'rejected') throw part.reason;
      return Object.assign({}, ...parts.flatMap(part => part.status === 'fulfilled' ? [part.value] : []));
    }
  }

  /**
   * One request per wave answers independent questions, each with its own instruction and criteria.
   * The dependency rule is the caller's contract: no question's criteria may depend on a sibling
   * answer. Questions with fewer than two labels are resolved host-side; a wave over the byte cap is
   * pre-split; a rejected request is bisected until the bad question is isolated, and that question
   * falls back to a single-question request. Every answered question emits one decision event
   * carrying `decisionId` and the shared `wave` request id, and records a path entry.
   */
  async chooseWave(state: State, questions: Record<string, WaveQuestionSpec>, request: WaveRequest): Promise<Record<string, WaveAnswer>> {
    const context = request.context ?? this.runContext;
    const answers: Record<string, WaveAnswer> = {};
    const queued: Array<{ key: string; spec: WaveQuestionSpec }> = [];
    for (const [key, spec] of Object.entries(questions)) {
      const labels = Object.keys(spec.criteria);
      if (!labels.length) throw new Error(`No valid labels for wave question ${key}.`);
      if (labels.length === 1) {
        // Fewer than two labels is host-derived: never part of a wave, never a request.
        answers[key] = { choice: labels[0]!, alternatives: [{ label: labels[0]!, probability: 1 }], nearTie: false };
        continue;
      }
      if (context.isWaveShapeBlacklisted(key)) {
        await this.askWaveQuestion(state, key, spec, request, context, answers);
        continue;
      }
      queued.push({ key, spec });
    }
    await this.sendWave(state, queued, request, context, answers);
    return answers;
  }

  /** Send one wave part: pre-split, budget pre-check, one request id, one event per question. */
  private async sendWave(state: State, part: Array<{ key: string; spec: WaveQuestionSpec }>, request: WaveRequest, context: RunContext, answers: Record<string, WaveAnswer>): Promise<void> {
    if (!part.length) return;
    const chunks = splitWave(state, part);
    if (chunks.length > 1) {
      // A wave over the byte budget pre-splits: every part is its own wave request.
      for (const chunk of chunks) await this.sendWave(state, chunk, request, context, answers);
      return;
    }
    // Budget pre-check: the worst case (every question asked singly plus bisection overhead) must fit.
    this.assertRequestBudget(waveWorstCase(part.length));
    const waveId = context.allocateWaveId();
    const waveQuestions = Object.fromEntries(part.map(({ key, spec }) => [key, { instruction: spec.instruction, criteria: spec.criteria }]));
    let result: WaveDecisionResult;
    try {
      result = await this.attemptWave(state, waveQuestions, request);
    } catch (error) {
      if (waveFailureKind(error) !== 'bisect') throw error;
      if (part.length > 1) {
        // A rejected wave: bisect until the bad question is isolated.
        const middle = Math.ceil(part.length / 2);
        await this.sendWave(state, part.slice(0, middle), request, context, answers);
        await this.sendWave(state, part.slice(middle), request, context, answers);
        return;
      }
      // The bad question is isolated: skip it from the wave, journal it, and ask it singly.
      const { key, spec } = part[0]!;
      const detail = errorText(error);
      context.recordWaveBisection(key);
      await request.onSkip?.(key, detail);
      try {
        await this.askWaveQuestion(state, key, spec, request, context, answers);
      } catch (fallback) {
        throw new DecisionError(`Wave question ${key} was skipped after a provider rejection and its single-question fallback failed: ${errorText(fallback)}`, { cause: fallback });
      }
      return;
    }
    for (const { key, spec } of part) {
      const cell = result.value[key];
      if (cell === undefined) throw new DecisionError(`The wave did not answer question ${key}.`);
      await this.recordWaveAnswer(state, request, context, key, spec, cell, waveId, result.metadata.model, answers);
    }
  }

  /** One wave request, with one `max_tokens_exceeded` compaction retry when a builder is supplied. */
  private async attemptWave(state: State, questions: Record<string, WaveQuestion>, request: WaveRequest): Promise<WaveDecisionResult> {
    try {
      return await this.session.chooseWave(jsonState(state), questions);
    } catch (error) {
      if (request.retryState === undefined || !(error instanceof DecisionError) || !/max_tokens_exceeded/.test(error.message)) throw error;
      this.signal.throwIfAborted();
      return this.session.chooseWave(jsonState(request.retryState(state)), questions);
    }
  }

  /** One question asked alone: a blacklisted shape, or a bisected question's single fallback. */
  private async askWaveQuestion(state: State, key: string, spec: WaveQuestionSpec, request: WaveRequest, context: RunContext, answers: Record<string, WaveAnswer>): Promise<void> {
    const slot = spec.slot ?? spec.identity?.slot ?? key;
    const choice = await this.chooseWithAlternatives(state, spec.instruction, spec.criteria, {
      scope: request.scope, questionKey: slot, kind: spec.kind ?? request.kind ?? 'structural', context,
      identity: { ...spec.identity, slot },
      ...(spec.answer === undefined ? {} : { answer: spec.answer }),
      ...(spec.answers === undefined ? {} : { answers: spec.answers }),
    });
    answers[key] = { choice: choice.choice, decisionId: choice.decisionId, alternatives: choice.alternatives, nearTie: choice.nearTie };
  }

  private async recordWaveAnswer(state: State, request: WaveRequest, context: RunContext, key: string, spec: WaveQuestionSpec, cell: WaveChoice, waveId: number, model: string, answers: Record<string, WaveAnswer>): Promise<void> {
    const slot = spec.slot ?? spec.identity?.slot ?? key;
    const questionIdentity = mergeIdentity(identity(state), { ...spec.identity, slot });
    const alternatives = [...cell.alternatives];
    const nearTie = isNearTie(alternatives, cell.choice);
    const decisionId = context.allocateDecisionId();
    const answer = spec.answer ?? spec.answers?.[cell.choice];
    context.recordDecision(request.scope, {
      decisionId, questionKey: slot, identity: questionIdentity, chosen: cell.choice, alternatives, nearTie,
      kind: spec.kind ?? request.kind ?? 'structural',
      ...(answer === undefined ? {} : { answer }),
      ...(spec.answers === undefined ? {} : { answers: { ...spec.answers } }),
    });
    answers[key] = { choice: cell.choice, decisionId, alternatives, nearTie };
    await this.onDecision({ choice: cell.choice, confidence: cell.confidence, model, options: alternatives, decisionId, wave: waveId, nearTie, ...questionIdentity });
  }
}

/** Request bytes of one wave entry, mirroring the greedy accounting in scored-grid.ts. */
const waveEntryBytes = (key: string, spec: WaveQuestionSpec): number =>
  Buffer.byteLength(JSON.stringify({ [key]: { type: 'choice', instructions: spec.instruction, criteria: spec.criteria } })) - 2;

/** Greedy byte pre-split: one request per part, each within MAX_WAVE_REQUEST_BYTES. */
const splitWave = (state: State, part: Array<{ key: string; spec: WaveQuestionSpec }>): Array<Array<{ key: string; spec: WaveQuestionSpec }>> => {
  const framing = Buffer.byteLength(JSON.stringify({ state, questions: {} }));
  const chunks: Array<Array<{ key: string; spec: WaveQuestionSpec }>> = [];
  let current: Array<{ key: string; spec: WaveQuestionSpec }> = [];
  let bytes = framing;
  for (const item of part) {
    const entry = waveEntryBytes(item.key, item.spec);
    if (current.length && bytes + entry + 1 > MAX_WAVE_REQUEST_BYTES) { chunks.push(current); current = []; bytes = framing; }
    bytes += entry + (current.length ? 1 : 0);
    current.push(item);
    if (bytes > MAX_WAVE_REQUEST_BYTES) throw new LimitError(`Wave question ${item.key} exceeds the safe request size (${MAX_WAVE_REQUEST_BYTES} bytes); the request was not sent.`);
  }
  if (current.length) chunks.push(current);
  return chunks;
};
