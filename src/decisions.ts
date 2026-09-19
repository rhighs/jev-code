import { DecisionSession, createDecisionSession } from './sdk/decisions.js';
import { RunResources } from './sdk/resources.js';
import { DecisionError, LimitError, type DecisionProvider, type DecisionResult, type JsonObject } from './sdk/types.js';
import type { DecisionEventData } from './types.js';

export type State = Record<string, unknown>;

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

  private readonly resources: RunResources;
  private readonly session: DecisionSession;

  constructor(
    private readonly provider: DecisionProvider,
    private readonly maxRequests: number,
    signal: AbortSignal,
    private readonly onDecision: (data: DecisionEventData) => Promise<void> = async () => {},
    concurrency = 4,
    resources?: RunResources,
  ) {
    this.resources = resources ?? new RunResources({ limits: { decisions: maxRequests }, signal, concurrency });
    this.session = createDecisionSession(provider, this.resources);
    this.signal = this.resources.signal;
  }

  fork(signal: AbortSignal): Decisions {
    return new Decisions(this.provider, this.maxRequests, signal, this.onDecision, 1, this.resources.fork(signal));
  }

  observe(onDecision: (data: DecisionEventData) => Promise<void>): Decisions {
    return new Decisions(this.provider, this.maxRequests, this.signal, onDecision, 1, this.resources);
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
      } else {
        await this.onDecision({ questions: result.metadata.questions, model: result.metadata.model });
      }
    });
  }

  async choose(state: State, instructions: string, criteria: Record<string, string>): Promise<string> {
    const result = await this.observed(state).choose(jsonState(state), instructions, criteria);
    return result.value;
  }

  async probability(state: State, instructions: string): Promise<number> {
    const result = await this.observed(state).probability(jsonState(state), instructions);
    return result.value;
  }

  async score(state: State, instructions: string, levels: string[]): Promise<{ expected: number; probabilities: number[] }> {
    const result = await this.observed(state).score(jsonState(state), instructions, levels);
    return { expected: result.value.expected, probabilities: [...result.value.probabilities] };
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
}
