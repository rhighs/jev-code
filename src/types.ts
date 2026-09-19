import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import type { TextProgress, TextChange } from './grid.js';

/** Implement this interface to replace Jev with a deterministic test driver. */
export interface DecisionProvider {
  decide<Q extends Questions>(state: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>>;
}

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
  select?(instruction: string, criteria: Record<string, string>, extra: Record<string, unknown>): Promise<{ choice: string; confidence: number }>;
  proposals?: { used: number; max: number };
  assertRequests?(count: number): void;
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

export interface ToolRecord extends Record<string, unknown> {
  turn: number;
  tool: string;
  args: ToolArgs;
  result: ToolResult;
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
}
export interface TextEventData extends TextProgress {
  field: string;
  bytes: number;
  done: boolean;
  change: TextChange | null;
}
export interface HarnessEventData {
  start: { schema: 1; prompt: string; workspace: string; decoder: 'dynamic'; limits: { turns: number; requests: number }; journal: string | null };
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

export class LimitError extends Error {}
export class DecisionError extends Error {}
