import type { DecisionAlternative } from './sdk/types.js';
import type { DecisionEventData } from './types.js';

/** Identity fields attached to a recorded decision, mirroring decision events. */
export type DecisionIdentity = Pick<DecisionEventData, 'field' | 'phase' | 'slot' | 'unit' | 'candidate'>;

/** Leaf decisions can be replayed with a forced answer; structural decisions cannot. */
export type DecisionKind = 'leaf' | 'structural';

export interface DecisionPathEntry {
  /** Monotonic within the owning run context; events and downstream consumers key by this. */
  decisionId: number;
  /** The builder slot that asked the question (e.g. `argument_1`). */
  questionKey: string;
  identity: DecisionIdentity;
  chosen: string;
  /** Ordered alternatives (highest probability first), retained for repair. */
  alternatives: DecisionAlternative[];
  /** Canonical near-tie flag: top-two gap <= 0.1 or the chosen label is not the probability argmax. */
  nearTie: boolean;
  kind: DecisionKind;
}

export interface PathDecisionRequest {
  /** Attempt scope from attemptScope(); identifies the unit attempt being recorded. */
  scope: string;
  questionKey: string;
  kind: DecisionKind;
  /** Context to record into; defaults to the facade's shared context. */
  context?: RunContext;
}

export interface PathChoice {
  choice: string;
  decisionId: number;
  alternatives: DecisionAlternative[];
  nearTie: boolean;
}

export interface LineSlot {
  slot: string;
  unit?: string;
  candidate?: number;
  decisionId?: number;
}

/** A per-run resource (the Python serializer worker) owned and disposed by the context. */
export interface RunContextWorker {
  dispose(): void | Promise<void>;
}

export class RunContextDisposedError extends Error {
  constructor(message = 'The run context has been disposed; create a new context for another run.') {
    super(message);
    this.name = 'RunContextDisposedError';
  }
}

const SEPARATOR = '\0';

/** Attempt scope key: one ordered decision path per (field, unit, candidate) generation. */
export const attemptScope = (field: string, unit?: string, candidate?: number): string =>
  `${field}${SEPARATOR}${unit ?? ''}${SEPARATOR}${candidate === undefined ? '' : String(candidate)}`;

/**
 * Run-scoped generation state: decision paths and retained alternatives, the within-run unit
 * cache, per-file line-to-slot maps, and the per-run serializer worker handle. Created by
 * Harness.run, shared by forked Decisions instances, and disposed at run end. Direct library
 * callers get the process-scoped default from defaultRunContext() and close it explicitly with
 * closeDefaultRunContext(); no other module-level state exists.
 */
export class RunContext {
  /** Validated unit bodies and symbols for within-run reuse, keyed by (path, normalized task text). */
  readonly units = new Map<string, unknown>();
  /** Per-written-file line-to-slot maps for runtime-failure attribution. */
  readonly lines = new Map<string, Map<number, LineSlot>>();

  private readonly paths = new Map<string, DecisionPathEntry[]>();
  private readonly byId = new Map<number, DecisionPathEntry>();
  private nextDecisionId = 1;
  private worker: RunContextWorker | undefined;
  private disposed = false;

  get isDisposed(): boolean { return this.disposed; }

  allocateDecisionId(): number {
    this.assertActive();
    return this.nextDecisionId++;
  }

  /** Start a fresh attempt for a scope; any previous entries for it are invalidated. */
  beginAttempt(scope: string): void {
    this.invalidateScope(scope);
  }

  invalidateScope(scope: string): void {
    this.assertActive();
    const entries = this.paths.get(scope);
    if (entries === undefined) return;
    this.paths.delete(scope);
    for (const entry of entries) this.byId.delete(entry.decisionId);
  }

  /** Regenerating a unit invalidates every recorded attempt for it, all search candidates included. */
  invalidateUnitAttempts(field: string, unit: string): void {
    this.assertActive();
    const prefix = `${field}${SEPARATOR}${unit}${SEPARATOR}`;
    for (const scope of [...this.paths.keys()]) if (scope.startsWith(prefix)) this.invalidateScope(scope);
  }

  recordDecision(scope: string, entry: DecisionPathEntry): void {
    this.assertActive();
    const entries = this.paths.get(scope);
    if (entries === undefined) this.paths.set(scope, [entry]);
    else entries.push(entry);
    this.byId.set(entry.decisionId, entry);
  }

  /** The ordered decision path recorded for an attempt, oldest first. */
  pathFor(scope: string): readonly DecisionPathEntry[] {
    this.assertActive();
    return this.paths.get(scope) ?? [];
  }

  /** Resolve a recorded decision by its id; invalidated entries are gone. */
  decisionEntry(decisionId: number): DecisionPathEntry | undefined {
    this.assertActive();
    return this.byId.get(decisionId);
  }

  recordLine(path: string, line: number, slot: LineSlot): void {
    this.assertActive();
    let map = this.lines.get(path);
    if (map === undefined) {
      map = new Map();
      this.lines.set(path, map);
    }
    map.set(line, slot);
  }

  slotAtLine(path: string, line: number): LineSlot | undefined {
    this.assertActive();
    return this.lines.get(path)?.get(line);
  }

  setWorker(worker: RunContextWorker | undefined): void {
    this.assertActive();
    this.worker = worker;
  }

  get activeWorker(): RunContextWorker | undefined { return this.worker; }

  /** Idempotent: clears run-scoped state and shuts the owned worker down. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    this.worker = undefined;
    this.paths.clear();
    this.byId.clear();
    this.units.clear();
    this.lines.clear();
    await worker?.dispose();
  }

  private assertActive(): void {
    if (this.disposed) throw new RunContextDisposedError();
  }
}

let processDefault: RunContext | undefined;

/** A fresh isolated context for one run or direct library caller. */
export const createRunContext = (): RunContext => new RunContext();

/** Process-scoped default for direct library callers that do not thread their own context. */
export const defaultRunContext = (): RunContext => processDefault ??= new RunContext();

/** Dispose the process-scoped default; a later defaultRunContext() creates a fresh context. */
export const closeDefaultRunContext = async (): Promise<void> => {
  const context = processDefault;
  processDefault = undefined;
  await context?.dispose();
};
