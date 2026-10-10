import type { TextProgress, TextChange } from './grid.js';
import type { RunContext } from './run-context.js';
export { DecisionError, LimitError } from './sdk/types.js';
export type { DecisionProvider } from './sdk/types.js';

export type Field = {
  description: string;
} & (
  | { type: 'string'; allowEmpty?: boolean; maxBytes?: number }
  | { type: 'number'; min?: number; max?: number; default?: number }
  | { type: 'boolean' }
  | { type: 'enum'; choices: Record<string, string> }
);

export interface ToolResult {
  ok: boolean;
  output: string;
  data?: Record<string, unknown>;
}

export interface ToolContext {
  workspace: string;
  signal: AbortSignal;
  resolvePath(path: string): Promise<string>;
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => Promise<void>;
  assertRequests?(count: number): void;
  /**
   * Run-scoped generation context when a harness owns the run; validation routes through its
   * serializer worker. Direct tool callers omit it and get the process-scoped default.
   */
  runContext?: RunContext;
}

export type ToolArgs = Record<string, string | number | boolean>;

export interface Tool {
  name: string;
  description: string;
  fields: Record<string, Field>;
  /** Mutations and shell execution can be confirmed by the host. */
  effect: 'read' | 'write' | 'shell';
  execute(args: ToolArgs, context: ToolContext): Promise<ToolResult>;
}

/** How a runtime repair rebuilt the failing file(s); journaled on tool_end.repair. */
export type RepairKind = 'unit-replay' | 'candidate-reuse' | 'module-substitution' | 'unit-regeneration' | 'module-regeneration' | 'none';

/** Journaled repair metadata on a tool_end record: what was rebuilt, from which decision, and why. */
export interface ToolRepairRecord {
  kind: RepairKind;
  target: string;
  decisionId?: number;
  forced?: string;
  notes?: string[];
  /** Repair cycle within the failure (1-based); absent on the repair write itself. */
  cycle?: number;
}

export interface ToolRecord extends Record<string, unknown> {
  turn: number;
  tool: string;
  args: ToolArgs;
  result: ToolResult;
  /** Present when this record is a repair rebuild or the retry of a repaired failure. */
  repair?: ToolRepairRecord;
}

export type RunStatus = 'completed' | 'blocked' | 'limited' | 'cancelled' | 'error';

export interface RunResult {
  id: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  turnTimings: Array<{ turn: number; durationMs: number; elapsedMs: number; requests: number }>;
  status: RunStatus;
  summary: string;
  modelSummary?: string;
  turns: number;
  requests: number;
  usage: { inputTokens: number; outputTokens: number };
  records: ToolRecord[];
}

export interface DecisionOption { label: string; probability: number }
export interface DecisionEventData {
  model: string;
  choice?: string;
  confidence?: number;
  probability?: number;
  questions?: number;
  options?: DecisionOption[];
  line?: string;
  field?: string;
  phase?: string;
  slot?: string;
  unit?: string;
  candidate?: number;
  /** Monotonic decision id within the run; present on alternatives-aware decisions. */
  decisionId?: number;
  /** Canonical near-tie flag: top-two gap <= 0.1 or the chosen label is not the probability argmax. */
  nearTie?: boolean;
  /** Wave (batched request) id; every question answered by one request carries the same id. */
  wave?: number;
}
export interface TextEventData extends TextProgress {
  field: string;
  bytes: number;
  done: boolean;
  change: TextChange | null;
}
export interface HarnessEventData {
  /**
   * `resume` is additive and present only on a resumed run: `from` is the journaled run id the
   * run continues, `turns` the turns carried over, and `requests` the request usage charged to
   * the new run's budget (so transcript counters and the enforced budget agree).
   */
  start: { schema: 1; prompt: string; workspace: string; decoder: 'dynamic'; limits: { turns: number; requests: number }; journal: string | null; resume?: { from: string; turns: number; requests: number } };
  turn: { files: number; plan: string };
  turn_end: { durationMs: number; elapsedMs: number; requests: number };
  action: { tool: string };
  decision: DecisionEventData;
  text: TextEventData;
  tool_start: { tool: string; args: ToolRecord['args'] };
  tool_output: { stream: 'stdout' | 'stderr'; text: string };
  tool_end: ToolRecord;
  input: { instruction: string };
  end: { status: RunStatus; summary: string; modelSummary: string | null; turns: number; requests: number; usage: RunResult['usage']; startedAt: string; endedAt: string; durationMs: number };
}
interface EventMetadata {
  runId: string;
  timestamp: string;
  elapsedMs: number;
  turn: number;
}
export type HarnessEvent = { [K in keyof HarnessEventData]: EventMetadata & { type: K; data: HarnessEventData[K] } }[keyof HarnessEventData];
