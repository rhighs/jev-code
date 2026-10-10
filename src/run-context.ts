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
  /** Criterion text of the chosen label, when the builder supplied it (used to match failure text). */
  answer?: string;
  /** The full label-to-criterion map for the question, when supplied (used to decode alternatives). */
  answers?: Record<string, string>;
}

export interface PathDecisionRequest {
  /** Attempt scope from attemptScope(); identifies the unit attempt being recorded. */
  scope: string;
  questionKey: string;
  kind: DecisionKind;
  /** Context to record into; defaults to the facade's shared context. */
  context?: RunContext;
  /** Criterion text of the chosen label, for runtime-failure attribution. */
  answer?: string;
  /** The full label-to-criterion map for the question, so alternatives can be decoded. */
  answers?: Record<string, string>;
  /**
   * Per-question identity override merged over the state-derived identity. Wave questions share one
   * state but record their own slot, and field-wave questions record their own field.
   */
  identity?: Partial<DecisionIdentity>;
}

/** Merge a per-question identity override over the state-derived identity. */
export const mergeIdentity = (base: DecisionIdentity, override?: Partial<DecisionIdentity>): DecisionIdentity => {
  if (override === undefined) return base;
  const merged: DecisionIdentity = { ...base };
  if (override.field !== undefined) merged.field = override.field;
  if (override.phase !== undefined) merged.phase = override.phase;
  if (override.slot !== undefined) merged.slot = override.slot;
  if (override.unit !== undefined) merged.unit = override.unit;
  if (override.candidate !== undefined) merged.candidate = override.candidate;
  return merged;
};

export interface PathChoice {
  choice: string;
  decisionId: number;
  alternatives: DecisionAlternative[];
  nearTie: boolean;
}

/**
 * A decision-path entry rebuilt best-effort from a resumed journal's decision events. The journal
 * carries the identity, chosen label, and alternatives, but not the leaf/structural kind or the
 * answer map, so seeded entries never enable forced-answer replay; they only preserve ids and
 * alternatives.
 */
export interface DecisionSeed {
  decisionId: number;
  scope: string;
  questionKey: string;
  identity: DecisionIdentity;
  chosen: string;
  alternatives: DecisionAlternative[];
  nearTie: boolean;
  kind?: DecisionKind;
}

export interface LineSlot {
  slot: string;
  unit?: string;
  candidate?: number;
  decisionId?: number;
  /** Attempt scope whose recorded decisions produced this line, for failure attribution. */
  scope?: string;
  /** Unit-cache target the written file belongs to. */
  target?: string;
  /** Generation field that produced the written file. */
  field?: string;
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
  private readonly sources = new Map<string, string>();
  private readonly candidates = new Map<string, unknown[]>();
  private readonly generationTasks = new Map<string, { task: string; project: boolean }>();
  private readonly waveBisections = new Map<string, number>();
  private readonly waveBlacklist = new Set<string>();
  private nextDecisionId = 1;
  private nextWaveId = 1;
  private worker: RunContextWorker | undefined;
  private disposed = false;

  get isDisposed(): boolean { return this.disposed; }

  allocateDecisionId(): number {
    this.assertActive();
    return this.nextDecisionId++;
  }

  /** Allocate the request id for one wave (one batched provider request). */
  allocateWaveId(): number {
    this.assertActive();
    return this.nextWaveId++;
  }

  /**
   * Count a wave bisection that isolated one question shape. The second isolation blacklists the
   * shape, so later waves ask it singly instead of repeating the bisection cost; returns true when
   * this call blacklisted the shape.
   */
  recordWaveBisection(shape: string): boolean {
    this.assertActive();
    const count = (this.waveBisections.get(shape) ?? 0) + 1;
    this.waveBisections.set(shape, count);
    if (count >= 2) {
      this.waveBlacklist.add(shape);
      return true;
    }
    return false;
  }

  isWaveShapeBlacklisted(shape: string): boolean {
    this.assertActive();
    return this.waveBlacklist.has(shape);
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

  /**
   * Seed decision paths from a resumed journal. Ids are preserved and the allocator continues above
   * the highest seeded id, so new decisions never collide with journaled ones. Seeded entries carry
   * no answer map and default to the structural kind, so forced-answer replay skips them.
   */
  seedDecisions(seeds: readonly DecisionSeed[]): void {
    this.assertActive();
    for (const seed of seeds) {
      this.recordDecision(seed.scope, {
        decisionId: seed.decisionId, questionKey: seed.questionKey, identity: seed.identity,
        chosen: seed.chosen, alternatives: [...seed.alternatives], nearTie: seed.nearTie,
        kind: seed.kind ?? 'structural',
      });
      if (seed.decisionId >= this.nextDecisionId) this.nextDecisionId = seed.decisionId + 1;
    }
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

  /** Replace the whole line map for a written file; used by assembly after each generation. */
  recordLineMap(path: string, slots: ReadonlyMap<number, LineSlot>): void {
    this.assertActive();
    this.lines.set(path, new Map(slots));
  }

  slotAtLine(path: string, line: number): LineSlot | undefined {
    this.assertActive();
    return this.lines.get(path)?.get(line);
  }

  /** Record the exact source generated for a file, so runtime repair can refuse to touch an edited file. */
  recordSource(path: string, source: string): void {
    this.assertActive();
    this.sources.set(path, source);
  }

  sourceFor(path: string): string | undefined {
    this.assertActive();
    return this.sources.get(path);
  }

  /**
   * Move the line map and source recorded under a generation field to the concrete written path
   * (single-file writes know the path only after the tool runs). A no-op when they are the same.
   */
  adoptWrittenFile(from: string, to: string): void {
    this.assertActive();
    if (from === to) return;
    const lines = this.lines.get(from);
    if (lines !== undefined) {
      this.lines.delete(from);
      this.lines.set(to, lines);
    }
    const source = this.sources.get(from);
    if (source !== undefined) {
      this.sources.delete(from);
      this.sources.set(to, source);
    }
  }

  /** Retain validated-but-dropped search candidates for one (target, unit) as repair candidates. */
  retainCandidates(target: string, unit: string, bodies: readonly unknown[]): void {
    this.assertActive();
    if (!bodies.length) return;
    const key = `${target}${SEPARATOR}${unit}`;
    this.candidates.set(key, [...(this.candidates.get(key) ?? []), ...bodies]);
  }

  candidatesFor(target: string, unit: string): readonly unknown[] {
    this.assertActive();
    return this.candidates.get(`${target}${SEPARATOR}${unit}`) ?? [];
  }

  /** Record the normalized task text a write target was generated for; runtime repair replays with it. */
  recordGenerationTask(target: string, task: string, project: boolean): void {
    this.assertActive();
    this.generationTasks.set(target, { task, project });
  }

  generationTaskFor(target: string): { task: string; project: boolean } | undefined {
    this.assertActive();
    return this.generationTasks.get(target);
  }

  /**
   * Consume a used repair alternative: the recorded choice moves to the forced label and the label
   * leaves the retained alternatives, so the same runner-up is not replayed twice.
   */
  consumeAlternative(decisionId: number, label: string): boolean {
    this.assertActive();
    const entry = this.byId.get(decisionId);
    if (entry === undefined || entry.chosen === label) return false;
    entry.chosen = label;
    const answer = entry.answers?.[label];
    if (answer !== undefined) entry.answer = answer;
    entry.alternatives = entry.alternatives.filter(alternative => alternative.label !== label);
    return true;
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
    this.sources.clear();
    this.candidates.clear();
    this.generationTasks.clear();
    this.waveBisections.clear();
    this.waveBlacklist.clear();
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
