import { choice, noul, score, type EntryType, type Questions, type ScoreCriteria, type SystemOneResult } from '@typesafe-ai/sdk';
import { RunResources, type RunResourceOptions } from './resources.js';
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

const DISTRIBUTION_TOLERANCE = 1e-3;
const MAX_ALTERNATIVES = 4;

export interface DecisionSessionOptions extends RunResourceOptions {
  resources?: RunResources;
  onDecision?: (result: DecisionResult) => void | Promise<void>;
}

function invalid(message: string): never {
  throw new DecisionError(message, { evidence: { kind: 'invalid-response', detail: message } });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
  if (Math.abs(total - 1) > DISTRIBUTION_TOLERANCE) invalid(message);
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
  readonly resources: RunResources;
  readonly signal: AbortSignal;

  constructor(
    private readonly provider: DecisionProvider,
    options: DecisionSessionOptions = {},
  ) {
    if (options.resources !== undefined && (options.limits !== undefined || options.concurrency !== undefined ||
      options.signal !== undefined || options.timeoutMs !== undefined)) {
      throw new Error('Pass either resources or run resource options, not both.');
    }
    this.resources = options.resources ?? new RunResources(options);
    this.signal = this.resources.signal;
    this.onDecision = options.onDecision;
  }

  private readonly onDecision: ((result: DecisionResult) => void | Promise<void>) | undefined;

  fork(signal?: AbortSignal): DecisionSession {
    return new DecisionSession(this.provider, {
      resources: this.resources.fork(signal),
      ...(this.onDecision === undefined ? {} : { onDecision: this.onDecision }),
    });
  }

  observe(onDecision: (result: DecisionResult) => void | Promise<void>): DecisionSession {
    if (this.onDecision === undefined) return new DecisionSession(this.provider, { resources: this.resources, onDecision });
    const previous = this.onDecision;
    return new DecisionSession(this.provider, {
      resources: this.resources,
      onDecision: async result => {
        await Promise.all([previous(result), onDecision(result)]);
      },
    });
  }

  /** Bind this session's provider and observers to another scope of the same run resources. */
  withResources(resources: RunResources): DecisionSession {
    return new DecisionSession(this.provider, {
      resources,
      ...(this.onDecision === undefined ? {} : { onDecision: this.onDecision }),
    });
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
    await this.onDecision?.(result);
    return result;
  }

  async probability(state: JsonObject, instructions: string): Promise<ProbabilityDecisionResult> {
    const response = await this.ask(state, { verdict: noul(instructions) });
    this.assertAnswerKeys(response.answers, ['verdict']);
    const answer: unknown = response.answers.verdict;
    if (!isRecord(answer) || answer.type !== 'noul') invalid('Jev returned an invalid noul answer.');
    const value = assertUnit(answer.noul, 'Jev returned an invalid noul.');
    const result: ProbabilityDecisionResult = {
      type: 'probability', value,
      metadata: { model: response.model, usage: this.usage(response), probability: value },
    };
    await this.onDecision?.(result);
    return result;
  }

  async score(state: JsonObject, instructions: string, levels: readonly string[]): Promise<ScoreDecisionResult> {
    if (levels.length < 2) throw new Error('Score requires at least 2 levels.');
    const response = await this.ask(state, { rating: score(instructions, levels as unknown as ScoreCriteria) });
    this.assertAnswerKeys(response.answers, ['rating']);
    const answer: unknown = response.answers.rating;
    if (!isRecord(answer) || answer.type !== 'score') invalid('Jev returned an invalid score answer.');
    const labels = levels.map((_, index) => String(index));
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
    await this.onDecision?.(result);
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
      const probabilities = assertDistribution(answer.probabilities, labels, `Jev returned an invalid character distribution: ${key}`,
        label => `Jev returned an invalid or missing character probability: ${key}.${label}`);
      assertUnit(answer.confidence, `Jev returned invalid confidence for: ${key}`);
      let best = labels[0]!;
      for (const label of labels) if (probabilities[label]! > probabilities[best]!) best = label;
      if (probabilities[best]! <= 0) invalid(`Jev returned an invalid character distribution: ${key}`);
      values[key] = { choice: best, score: probabilities[best]!, probabilities };
    }
    const result: ManyChoiceDecisionResult = {
      type: 'many-choice',
      value: values,
      metadata: { model: response.model, usage: this.usage(response), questions: questionKeys.length },
    };
    await this.onDecision?.(result);
    return result;
  }

  private async ask<Q extends Questions>(state: JsonObject, questions: Q): Promise<SystemOneResult<Q>> {
    const input = cloneState(state);
    return this.resources.execute('decisions', async signal => {
      let response: SystemOneResult<Q>;
      try {
        response = await this.provider.decide(input, questions, signal);
      } catch (error) {
        if (signal.aborted) this.resources.throwIfAborted();
        const detail = error instanceof Error ? error.message : String(error);
        throw new DecisionError(detail, { cause: error, evidence: { kind: 'provider-failure', detail } });
      }
      this.resources.throwIfAborted();
      if (!isRecord(response) || typeof response.model !== 'string' || response.model.length === 0 || !isRecord(response.answers) || !isRecord(response.usage)) {
        invalid('Jev returned invalid response metadata.');
      }
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
        invalid('Jev returned invalid usage metadata.');
      }
      this.resources.addUsage({ inputTokens, outputTokens });
      return response;
    });
  }

  private usage(response: { usage: { input_tokens: number; output_tokens: number } }): TokenUsage {
    return { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  }

  private assertAnswerKeys(answers: object, expected: readonly string[]): void {
    const keys = Object.keys(answers);
    if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) invalid('Jev returned unexpected or missing answers.');
  }
}
