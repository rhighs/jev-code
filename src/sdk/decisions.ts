import { choice, noul, score, type EntryType, type Questions, type ScoreCriteria, type SystemOneResult } from '@typesafe-ai/sdk';
import { RunResources, resourceView, type ProgramResourceView, type RunResourceOptions } from './resources.js';
import {
  DecisionError,
  type ChoiceDecisionResult,
  type DecisionAlternative,
  type DecisionProvider,
  type DecisionResult,
  type JsonObject,
  type ManyChoiceDecisionResult,
  type ProbabilityDecisionResult,
  type ScoreDecisionResult,
  type TokenUsage,
} from './types.js';

const ROUNDING_STEP = 0.01;
const MAX_DISTRIBUTION_DRIFT = 0.1;
const MAX_ALTERNATIVES = 4;

export interface DecisionSessionOptions extends RunResourceOptions {
  onDecision?: (result: DecisionResult) => void | Promise<void>;
  eventTimeoutMs?: number;
}

interface SessionInternals {
  readonly provider: DecisionProvider;
  readonly resources: RunResources;
  readonly onDecision?: (result: DecisionResult) => void | Promise<void>;
  readonly eventTimeoutMs: number;
}

const DEFAULT_EVENT_TIMEOUT_MS = 5_000;
const sessionInternals = new WeakMap<DecisionSession, SessionInternals>();

function invalid(message: string): never {
  throw new DecisionError(message, { evidence: { kind: 'invalid-response', detail: message } });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertExactKeys = (value: Record<string, unknown>, allowed: readonly string[], message: string): void => {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) invalid(message);
};

const assertUnit = (value: unknown, message: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid(message);
  return value;
};

const assertDistribution = (
  value: unknown,
  labels: readonly string[],
  message: string,
  itemMessage: (label: string) => string = () => message,
): Record<string, number> => {
  if (!isRecord(value)) invalid(message);
  const keys = Object.keys(value);
  if (keys.length !== labels.length || keys.some(key => !labels.includes(key)) || labels.some(label => !Object.hasOwn(value, label))) invalid(message);
  const probabilities: Record<string, number> = {};
  let total = 0;
  for (const label of labels) {
    const probability = assertUnit(value[label], itemMessage(label));
    probabilities[label] = probability;
    total += probability;
  }
  if (Math.abs(total - 1) > Math.min(ROUNDING_STEP * labels.length / 2, MAX_DISTRIBUTION_DRIFT) + 1e-9) invalid(message);
  return probabilities;
};

const topAlternatives = (probabilities: Record<string, number>, labels: (key: string) => string = key => key): DecisionAlternative[] =>
  Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ALTERNATIVES)
    .map(([label, probability]) => ({ label: labels(label), probability }));

const assertJsonValue = (value: unknown, ancestors: Set<object>): void => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite.');
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`Unsupported JSON value: ${typeof value}.`);
  if (ancestors.has(value)) throw new TypeError('Circular JSON value.');
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('JSON objects must be plain objects.');
    for (const item of Object.values(value)) assertJsonValue(item, ancestors);
  }
  ancestors.delete(value);
};

const cloneState = (state: JsonObject): EntryType => {
  try {
    assertJsonValue(state, new Set());
    const serialized = JSON.stringify(state);
    if (serialized === undefined) throw new TypeError('State is not JSON-compatible.');
    const cloned = JSON.parse(serialized) as unknown;
    if (!isRecord(cloned)) throw new TypeError('State must be a JSON object.');
    return cloned as EntryType;
  } catch (error) {
    throw new Error('Decision state must contain only JSON-compatible values.', { cause: error });
  }
};

export class DecisionSession {
  get resources(): ProgramResourceView { return resourceView(sessionInternals.get(this)!.resources); }
  get signal(): AbortSignal { return sessionInternals.get(this)!.resources.signal; }

  constructor(
    provider: DecisionProvider,
    options: DecisionSessionOptions = {},
  ) {
    const eventTimeoutMs = options.eventTimeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS;
    if (!Number.isSafeInteger(eventTimeoutMs) || eventTimeoutMs < 1) throw new Error('eventTimeoutMs must be a positive safe integer.');
    sessionInternals.set(this, {
      provider,
      resources: new RunResources(options),
      ...(options.onDecision === undefined ? {} : { onDecision: options.onDecision }),
      eventTimeoutMs,
    });
  }

  fork(signal?: AbortSignal): DecisionSession {
    const internals = sessionInternals.get(this)!;
    return createDecisionSession(internals.provider, internals.resources.fork(signal), internals.onDecision, internals.eventTimeoutMs);
  }

  observe(onDecision: (result: DecisionResult) => void | Promise<void>): DecisionSession {
    const internals = sessionInternals.get(this)!;
    if (internals.onDecision === undefined) {
      return createDecisionSession(internals.provider, internals.resources, onDecision, internals.eventTimeoutMs);
    }
    const previous = internals.onDecision;
    return createDecisionSession(internals.provider, internals.resources, async result => {
        await Promise.all([previous(result), onDecision(result)]);
      }, internals.eventTimeoutMs);
  }

  async choose<const Criteria extends Record<string, string>>(
    state: JsonObject,
    instructions: string,
    criteria: Criteria,
  ): Promise<ChoiceDecisionResult<keyof Criteria & string>> {
    const labels = Object.keys(criteria);
    if (labels.length < 2 || labels.length > 255) throw new Error('Choice requires 2-255 candidates.');
    const response = await this.ask(state, { selection: choice(instructions, criteria) });
    this.assertAnswerKeys(response.answers, ['selection']);
    const answer: unknown = response.answers.selection;
    if (!isRecord(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string') invalid('Jev returned an invalid choice answer.');
    assertExactKeys(answer, ['type', 'choice', 'confidence', 'probabilities'], 'Jev returned an invalid choice answer.');
    if (!Object.hasOwn(criteria, answer.choice)) invalid(`Jev returned an unavailable choice: ${answer.choice}`);
    const probabilities = assertDistribution(answer.probabilities, labels, 'Jev returned an invalid choice distribution.');
    const confidence = assertUnit(answer.confidence, 'Jev returned invalid confidence.');
    const result: ChoiceDecisionResult<keyof Criteria & string> = {
      type: 'choice',
      value: answer.choice as keyof Criteria & string,
      metadata: {
        model: response.model,
        usage: this.usage(response),
        confidence,
        probability: probabilities[answer.choice]!,
        alternatives: topAlternatives(probabilities),
      },
    };
    await this.notify(result);
    return result;
  }

  async probability(state: JsonObject, instructions: string): Promise<ProbabilityDecisionResult> {
    const response = await this.ask(state, { verdict: noul(instructions) });
    this.assertAnswerKeys(response.answers, ['verdict']);
    const answer: unknown = response.answers.verdict;
    if (!isRecord(answer) || answer.type !== 'noul') invalid('Jev returned an invalid noul answer.');
    assertExactKeys(answer, ['type', 'noul'], 'Jev returned an invalid noul answer.');
    const value = assertUnit(answer.noul, 'Jev returned an invalid noul.');
    const result: ProbabilityDecisionResult = {
      type: 'probability', value,
      metadata: { model: response.model, usage: this.usage(response), probability: value },
    };
    await this.notify(result);
    return result;
  }

  async score(state: JsonObject, instructions: string, levels: readonly string[]): Promise<ScoreDecisionResult> {
    if (levels.length < 2) throw new Error('Score requires at least 2 levels.');
    const response = await this.ask(state, { rating: score(instructions, levels as unknown as ScoreCriteria) });
    this.assertAnswerKeys(response.answers, ['rating']);
    const answer: unknown = response.answers.rating;
    if (!isRecord(answer) || answer.type !== 'score') invalid('Jev returned an invalid score answer.');
    assertExactKeys(answer, ['type', 'score', 'confidence', 'legend', 'probabilities'], 'Jev returned an invalid score answer.');
    const labels = levels.map((_, index) => String(index));
    if (!isRecord(answer.legend)) invalid('Jev returned an invalid score legend.');
    assertExactKeys(answer.legend, labels, 'Jev returned an invalid score legend.');
    for (const [index, level] of levels.entries()) {
      if (answer.legend[String(index)] !== level) invalid('Jev returned an invalid score legend.');
    }
    const distribution = assertDistribution(answer.probabilities, labels, 'Jev returned an invalid score distribution.');
    const probabilities = labels.map(label => distribution[label]!);
    const expected = probabilities.reduce((sum, probability, index) => sum + probability * index, 0);
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels.length - 1) {
      invalid('Jev returned an invalid score.');
    }
    const confidence = assertUnit(answer.confidence, 'Jev returned invalid confidence.');
    const result: ScoreDecisionResult = {
      type: 'score',
      value: { expected, probabilities },
      metadata: {
        model: response.model,
        usage: this.usage(response),
        confidence,
        alternatives: topAlternatives(distribution, key => levels[Number(key)]!),
      },
    };
    await this.notify(result);
    return result;
  }

  /** Batch form retained for the existing structured generators. */
  async chooseMany(state: JsonObject, instructions: Record<string, string>, criteria: Record<string, string>): Promise<ManyChoiceDecisionResult> {
    const questionKeys = Object.keys(instructions);
    const labels = Object.keys(criteria);
    if (questionKeys.length === 0) throw new Error('chooseMany requires at least one question.');
    if (labels.length < 2 || labels.length > 255) throw new Error('Choice requires 2-255 candidates.');
    const questions = Object.fromEntries(Object.entries(instructions).map(([key, text]) => [key, choice(text, criteria)]));
    const response = await this.ask(state, questions);
    this.assertAnswerKeys(response.answers, questionKeys);
    const values: ManyChoiceDecisionResult['value'] = {};
    for (const key of questionKeys) {
      const answer: unknown = response.answers[key];
      if (!isRecord(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string' || !Object.hasOwn(criteria, answer.choice)) {
        invalid(`Jev returned an invalid or missing cell choice: ${key}`);
      }
      assertExactKeys(answer, ['type', 'choice', 'confidence', 'probabilities'], `Jev returned an invalid or missing cell choice: ${key}`);
      const probabilities = assertDistribution(answer.probabilities, labels, `Jev returned an invalid character distribution: ${key}`,
        label => `Jev returned an invalid or missing character probability: ${key}.${label}`);
      assertUnit(answer.confidence, `Jev returned invalid confidence for: ${key}`);
      values[key] = { choice: answer.choice, score: probabilities[answer.choice]!, probabilities };
    }
    const result: ManyChoiceDecisionResult = {
      type: 'many-choice',
      value: values,
      metadata: { model: response.model, usage: this.usage(response), questions: questionKeys.length },
    };
    await this.notify(result);
    return result;
  }

  private async ask<Q extends Questions>(state: JsonObject, questions: Q): Promise<SystemOneResult<Q>> {
    const input = cloneState(state);
    const { provider, resources } = sessionInternals.get(this)!;
    return resources.execute('decisions', async signal => {
      let response: SystemOneResult<Q>;
      try {
        response = await provider.decide(input, questions, signal);
      } catch (error) {
        if (signal.aborted) resources.throwIfAborted();
        const detail = error instanceof Error ? error.message : String(error);
        throw new DecisionError(detail, { cause: error, evidence: { kind: 'provider-failure', detail } });
      }
      resources.throwIfAborted();
      if (!isRecord(response) || typeof response.model !== 'string' || response.model.length === 0 || !isRecord(response.answers) || !isRecord(response.usage)) {
        invalid('Jev returned invalid response metadata.');
      }
      assertExactKeys(response, ['model', 'answers', 'usage'], 'Jev returned invalid response metadata.');
      assertExactKeys(response.usage, ['input_tokens', 'output_tokens'], 'Jev returned invalid usage metadata.');
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
        invalid('Jev returned invalid usage metadata.');
      }
      resources.addUsage({ inputTokens, outputTokens });
      return response;
    });
  }

  private async notify(result: DecisionResult): Promise<void> {
    const { onDecision, resources, eventTimeoutMs } = sessionInternals.get(this)!;
    if (onDecision === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Decision observer did not settle within ${eventTimeoutMs}ms.`)), eventTimeoutMs);
    });
    try {
      const observed = (async (): Promise<void> => { await onDecision(result); })();
      await resources.raceSignal(Promise.race([observed, timeout]));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private usage(response: { usage: { input_tokens: number; output_tokens: number } }): TokenUsage {
    return { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  }

  private assertAnswerKeys(answers: object, expected: readonly string[]): void {
    const keys = Object.keys(answers);
    if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) invalid('Jev returned unexpected or missing answers.');
  }
}

export const createDecisionSession = (
  provider: DecisionProvider,
  resources: RunResources,
  onDecision?: (result: DecisionResult) => void | Promise<void>,
  eventTimeoutMs = DEFAULT_EVENT_TIMEOUT_MS,
): DecisionSession => {
  const session = Object.create(DecisionSession.prototype) as DecisionSession;
  sessionInternals.set(session, { provider, resources, ...(onDecision === undefined ? {} : { onDecision }), eventTimeoutMs });
  return session;
};

export const decisionSessionResources = (session: DecisionSession): RunResources => sessionInternals.get(session)!.resources;

export const rebindDecisionSession = (session: DecisionSession, resources: RunResources): DecisionSession => {
  const internals = sessionInternals.get(session)!;
  return createDecisionSession(internals.provider, resources, internals.onDecision, internals.eventTimeoutMs);
};
