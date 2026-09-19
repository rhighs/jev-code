import type { EntryType, JsonValue, Questions, SystemOneResult } from '@typesafe-ai/sdk';

export type { EntryType, JsonValue };

/** Replace Jev with any transport or deterministic local implementation. */
export interface DecisionProvider {
  decide<Q extends Questions>(state: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>>;
}

export type ResourceKind = 'decisions' | 'nodes';

export type DecisionFailureEvidence =
  | { kind: 'invalid-response'; detail: string }
  | { kind: 'provider-failure'; detail: string }
  | { kind: 'cancelled'; source: 'caller'; detail: string }
  | { kind: 'deadline-exceeded'; source: 'deadline'; timeoutMs: number }
  | { kind: 'exhausted'; resource: ResourceKind; limit: number; used: number };

interface ErrorOptionsWithEvidence extends ErrorOptions {
  evidence?: DecisionFailureEvidence;
}

interface ResourceErrorOptions extends ErrorOptions {
  evidence: Extract<DecisionFailureEvidence, { kind: 'exhausted' | 'deadline-exceeded' }>;
}

export class DecisionError extends Error {
  readonly evidence: DecisionFailureEvidence;

  constructor(message: string, options: ErrorOptionsWithEvidence = {}) {
    super(message, options);
    this.name = new.target.name;
    this.evidence = options.evidence ?? { kind: 'invalid-response', detail: message };
  }
}

export class CancelledError extends DecisionError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, { ...options, evidence: { kind: 'cancelled', source: 'caller', detail: message } });
  }
}

/** Also used by the compatibility application for its non-SDK limits. */
export class LimitError extends Error {
  readonly evidence: DecisionFailureEvidence | undefined;

  constructor(message: string, options: ErrorOptionsWithEvidence = {}) {
    super(message, options);
    this.name = new.target.name;
    this.evidence = options.evidence;
  }
}

/** A deadline or SDK resource budget exhausted by RunResources. */
export class ResourceExhaustedError extends LimitError {
  declare readonly evidence: ResourceErrorOptions['evidence'];

  constructor(message: string, options: ResourceErrorOptions) {
    super(message, options);
    this.evidence = options.evidence;
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DecisionAlternative {
  label: string;
  probability: number;
}

export interface DecisionMetadata {
  model: string;
  usage: TokenUsage;
  confidence?: number;
  probability?: number;
  alternatives?: readonly DecisionAlternative[];
}

export interface ChoiceDecisionResult<Label extends string = string> {
  type: 'choice';
  value: Label;
  metadata: DecisionMetadata & {
    confidence: number;
    probability: number;
    alternatives: readonly DecisionAlternative[];
  };
}

export interface ProbabilityDecisionResult {
  type: 'probability';
  value: number;
  metadata: DecisionMetadata & { probability: number };
}

export interface ScoreDecisionResult {
  type: 'score';
  value: { expected: number; probabilities: readonly number[] };
  metadata: DecisionMetadata & {
    confidence: number;
    alternatives: readonly DecisionAlternative[];
  };
}

export interface ManyChoiceDecisionResult {
  type: 'many-choice';
  value: Record<string, { choice: string; score: number; probabilities: Record<string, number> }>;
  metadata: DecisionMetadata & { questions: number };
}

export type DecisionResult = ChoiceDecisionResult | ProbabilityDecisionResult | ScoreDecisionResult | ManyChoiceDecisionResult;

export type JsonObject = { [key: string]: JsonValue };

interface ProgramEventBase {
  readonly schema: 1;
  readonly runId: string;
  readonly sequence: number;
}

export type ProgramEvent =
  | (ProgramEventBase & { readonly type: 'run-started' })
  | (ProgramEventBase & { readonly type: 'node-ready'; readonly nodeId: string; readonly path: string; readonly depth: number })
  | (ProgramEventBase & { readonly type: 'node-started'; readonly nodeId: string; readonly path: string; readonly depth: number })
  | (ProgramEventBase & { readonly type: 'node-completed'; readonly nodeId: string; readonly path: string; readonly depth: number })
  | (ProgramEventBase & { readonly type: 'node-failed'; readonly nodeId: string; readonly path: string; readonly depth: number; readonly detail: string })
  | (ProgramEventBase & { readonly type: 'node-cancelled'; readonly nodeId: string; readonly path: string; readonly depth: number; readonly detail: string })
  | (ProgramEventBase & { readonly type: 'node-invalid'; readonly nodeId: string; readonly path: string; readonly depth: number; readonly detail: string })
  | (ProgramEventBase & { readonly type: 'node-exhausted'; readonly nodeId: string; readonly path: string; readonly depth: number; readonly evidence: Extract<DecisionFailureEvidence, { kind: 'exhausted' | 'deadline-exceeded' }> })
  | (ProgramEventBase & { readonly type: 'decision-completed'; readonly nodeId: string; readonly path: string; readonly decision: DecisionResult })
  | (ProgramEventBase & { readonly type: 'run-completed'; readonly nodes: number })
  | (ProgramEventBase & { readonly type: 'run-failed'; readonly nodes: number; readonly detail: string })
  | (ProgramEventBase & { readonly type: 'run-invalid'; readonly nodes: number; readonly detail: string })
  | (ProgramEventBase & { readonly type: 'run-cancelled'; readonly nodes: number; readonly detail: string })
  | (ProgramEventBase & { readonly type: 'run-exhausted'; readonly nodes: number; readonly evidence: Extract<DecisionFailureEvidence, { kind: 'exhausted' | 'deadline-exceeded' }> });

export interface ProgramRunMetadata {
  readonly runId: string;
  readonly events: readonly ProgramEvent[];
  readonly droppedEvents: number;
  readonly resources: RunResourceSnapshotLike;
  readonly observerFailure?: { readonly detail: string };
}

/** Kept structural here so the public outcome types do not introduce a runtime import cycle. */
export interface RunResourceSnapshotLike {
  readonly used: Readonly<Record<ResourceKind, number>>;
  readonly limits: Readonly<Record<ResourceKind, number>>;
  readonly usage: TokenUsage;
  readonly inflight: number;
}

export type ProgramRunOutcome<Output> =
  | { readonly status: 'completed'; readonly value: Output; readonly metadata: ProgramRunMetadata }
  | { readonly status: 'failed'; readonly error: unknown; readonly detail: string; readonly metadata: ProgramRunMetadata }
  | { readonly status: 'invalid'; readonly detail: string; readonly metadata: ProgramRunMetadata }
  | { readonly status: 'cancelled'; readonly detail: string; readonly metadata: ProgramRunMetadata }
  | { readonly status: 'exhausted'; readonly evidence: Extract<DecisionFailureEvidence, { kind: 'exhausted' | 'deadline-exceeded' }>; readonly metadata: ProgramRunMetadata };
