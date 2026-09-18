import { choice, noul, score, type EntryType, type Questions, type ScoreCriteria, type SystemOneResult } from '@typesafe-ai/sdk';
import { DecisionError, LimitError, type DecisionProvider, type DecisionEventData, type DecisionOption } from './types.js';

export type State = Record<string, unknown>;

const topOptions = (probabilities: Record<string, number>, labels: (key: string) => string = key => key): DecisionOption[] =>
  Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key, probability]) => ({ label: labels(key), probability }));

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
interface Counters { requests: number; usage: { inputTokens: number; outputTokens: number }; inflight: number; waiters: Array<() => void> }

export class Decisions {
  get requests(): number { return this.counters.requests; }
  get exhausted(): boolean { return this.counters.requests >= this.maxRequests; }
  get usage(): { inputTokens: number; outputTokens: number } { return this.counters.usage; }

  constructor(
    private readonly provider: DecisionProvider,
    private readonly maxRequests: number,
    readonly signal: AbortSignal,
    private readonly onDecision: (data: DecisionEventData) => Promise<void> = async () => {},
    private readonly concurrency = 4,
    private readonly counters: Counters = { requests: 0, usage: { inputTokens: 0, outputTokens: 0 }, inflight: 0, waiters: [] },
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer.');
  }

  fork(signal: AbortSignal): Decisions {
    return new Decisions(this.provider, this.maxRequests, AbortSignal.any([this.signal, signal]), this.onDecision, this.concurrency, this.counters);
  }

  observe(onDecision: (data: DecisionEventData) => Promise<void>): Decisions {
    return new Decisions(this.provider, this.maxRequests, this.signal, onDecision, this.concurrency, this.counters);
  }

  private acquire(): Promise<void> {
    if (this.counters.inflight < this.concurrency) { this.counters.inflight++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter = (): void => { this.signal.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = (): void => {
        const idx = this.counters.waiters.indexOf(waiter);
        if (idx >= 0) this.counters.waiters.splice(idx, 1);
        reject(this.signal.reason);
      };
      this.signal.addEventListener('abort', onAbort, { once: true });
      this.counters.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.counters.waiters.shift();
    if (next) next(); else this.counters.inflight--;
  }

  private assertConfidence(value: unknown): void {
    if (!Number.isFinite(value) || (value as number) < 0 || (value as number) > 1) throw new DecisionError('Jev returned invalid confidence.');
  }

  assertRequestBudget(count: number): void {
    if (this.requests + count > this.maxRequests) throw new LimitError(`Request budget exhausted (${this.maxRequests}).`);
  }

  private async ask<Q extends Questions>(state: State, questions: Q): Promise<SystemOneResult<Q>> {
    this.signal.throwIfAborted();
    if (this.requests >= this.maxRequests) throw new LimitError(`Request budget exhausted (${this.maxRequests}).`);
    await this.acquire();
    let response: SystemOneResult<Q>;
    try {
      this.signal.throwIfAborted();
      if (this.requests >= this.maxRequests) throw new LimitError(`Request budget exhausted (${this.maxRequests}).`);
      this.counters.requests++;
      // Make the transport boundary explicit: state must contain JSON values only.
      try {
        response = await this.provider.decide(JSON.parse(JSON.stringify(state)) as EntryType, questions, this.signal);
      } catch (error) {
        this.signal.throwIfAborted();
        throw new DecisionError(error instanceof Error ? error.message : String(error), { cause: error });
      }
    } finally { this.release(); }
    this.signal.throwIfAborted();
    if (!response.usage || !Number.isFinite(response.usage.input_tokens) || response.usage.input_tokens < 0 ||
      !Number.isFinite(response.usage.output_tokens) || response.usage.output_tokens < 0) throw new DecisionError('Jev returned invalid usage metadata.');
    this.usage.inputTokens += response.usage.input_tokens;
    this.usage.outputTokens += response.usage.output_tokens;
    return response;
  }

  async choose(state: State, instructions: string, criteria: Record<string, string>): Promise<string> {
    const keys = Object.keys(criteria);
    if (keys.length < 2 || keys.length > 255) throw new Error('Choice requires 2–255 candidates.');
    const response = await this.ask(state, { selection: choice(instructions, criteria) });
    const answer = response.answers.selection;
    if (!answer || answer.type !== 'choice' || !answer.probabilities) throw new DecisionError('Jev returned an invalid choice answer.');
    if (!Object.hasOwn(criteria, answer.choice)) throw new DecisionError(`Jev returned an unavailable choice: ${answer.choice}`);
    for (const [key, probability] of Object.entries(answer.probabilities)) {
      if (!Object.hasOwn(criteria, key) || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new DecisionError('Jev returned an invalid choice distribution.');
      }
    }
    this.assertConfidence(answer.confidence);
    await this.onDecision({ choice: answer.choice, confidence: answer.confidence, model: response.model, options: topOptions(answer.probabilities), ...identity(state) });
    return answer.choice;
  }

  async probability(state: State, instructions: string): Promise<number> {
    const response = await this.ask(state, { verdict: noul(instructions) });
    const answer = response.answers.verdict;
    if (!answer || answer.type !== 'noul') throw new DecisionError('Jev returned an invalid noul answer.');
    const value = answer.noul;
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new DecisionError('Jev returned an invalid noul.');
    await this.onDecision({ probability: value, model: response.model });
    return value;
  }

  async score(state: State, instructions: string, levels: string[]): Promise<{ expected: number; probabilities: number[] }> {
    if (levels.length < 2) throw new Error('Score requires at least 2 levels.');
    const response = await this.ask(state, { rating: score(instructions, levels as unknown as ScoreCriteria) });
    const answer = response.answers.rating as { type?: string; score?: number; confidence?: number; probabilities?: Record<string, number> } | undefined;
    if (!answer || answer.type !== 'score' || !answer.probabilities || typeof answer.probabilities !== 'object') throw new DecisionError('Jev returned an invalid score answer.');
    if (Object.keys(answer.probabilities).some(key => !/^\d+$/.test(key) || Number(key) >= levels.length)) throw new DecisionError('Jev returned a score level outside the rubric.');
    const probabilities = levels.map((_, i) => answer.probabilities![String(i)] ?? 0);
    if (probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw new DecisionError('Jev returned an invalid score distribution.');
    if (!Number.isFinite(answer.score) || answer.score! < 0 || answer.score! > levels.length - 1) throw new DecisionError('Jev returned an invalid score.');
    this.assertConfidence(answer.confidence);
    const expected = probabilities.reduce((sum, p, i) => sum + p * i, 0);
    await this.onDecision({ choice: String(Math.round(expected)), confidence: answer.confidence!, model: response.model, options: topOptions(answer.probabilities, key => levels[Number(key)]!), ...identity(state) });
    return { expected, probabilities };
  }

  /** Parallel positions, each with a scored categorical distribution over characters. */
  async chooseMany(state: State, instructions: Record<string, string>, criteria: Record<string, string>): Promise<Record<string, { choice: string; score: number; probabilities: Record<string, number> }>> {
    const questions = Object.fromEntries(Object.entries(instructions).map(([key, text]) => [key, choice(text, criteria)]));
    let response: SystemOneResult<typeof questions>;
    try { response = await this.ask(state, questions); }
    catch (error) {
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
    const results: Record<string, { choice: string; score: number; probabilities: Record<string, number> }> = {};
    for (const key of Object.keys(instructions)) {
      const answer = response.answers[key];
      if (!answer || answer.type !== 'choice' || !Object.hasOwn(criteria, answer.choice) || !answer.probabilities ||
        !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
        throw new DecisionError(`Jev returned an invalid or missing cell choice: ${key}`);
      }
      let best = answer.choice;
      for (const label of Object.keys(criteria)) {
        const probability = answer.probabilities[label];
        if (!Number.isFinite(probability) || probability! < 0 || probability! > 1) throw new DecisionError(`Jev returned an invalid or missing character probability: ${key}.${label}`);
        if (probability! > answer.probabilities[best]!) best = label;
      }
      if (Object.keys(answer.probabilities).some(label => !Object.hasOwn(criteria, label)) || answer.probabilities[best]! <= 0) {
        throw new DecisionError(`Jev returned an invalid character distribution: ${key}`);
      }
      results[key] = { choice: best, score: answer.probabilities[best]!, probabilities: { ...answer.probabilities } };
    }
    await this.onDecision({ questions: Object.keys(results).length, model: response.model });
    return results;
  }
}
