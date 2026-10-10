import type { PythonNode } from './python-nodes.js';
import type { UnitCacheEntry } from './python-units.js';
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

/** Mutable parts of a recorded decision entry, captured so a failed repair can undo its consumption. */
export interface DecisionSnapshot {
  decisionId: number;
  chosen: string;
  answer?: string;
  alternatives: DecisionAlternative[];
}

/**
 * Mutable run state a repair rebuild can rewrite, captured so a failed repair write can undo the
 * rebuild. Maps are private to RunContext; the snapshot type is exported for callers that thread it
 * through a repair cycle.
 */
export interface RunStateSnapshot {
  units: Map<string, UnitCacheEntry>;
  keptCandidates: Map<string, number>;
  candidates: Map<string, PythonNode[][]>;
  generationTasks: Map<string, { task: string; project: boolean }>;
  paths: Map<string, DecisionPathEntry[]>;
  byId: Map<number, DecisionPathEntry>;
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

/**
 * Attempt scope key: one ordered decision path per (target, unit, candidate) generation. The target
 * is the unit-cache target — the concrete written path once known, else the generation field — so
 * two single-file writes through one body field never share a scope. `field` stays the first
 * argument for call-site readability; when `target` is omitted it defaults to `field`.
 */
export const attemptScope = (field: string, unit?: string, candidate?: number, target?: string): string =>
  `${target ?? field}${SEPARATOR}${unit ?? ''}${SEPARATOR}${candidate === undefined ? '' : String(candidate)}`;

/**
 * Run-scoped generation state: decision paths and retained alternatives, the within-run unit
 * cache, per-file line-to-slot maps, and the per-run serializer worker handle. Created by
 * Harness.run, shared by forked Decisions instances, and disposed at run end. Direct library
 * callers get the process-scoped default from defaultRunContext() and close it explicitly with
 * closeDefaultRunContext(); no other module-level state exists.
 */
export class RunContext {
  /** Validated unit tree for within-run reuse, keyed by write target; the task text lives in the entry. */
  readonly units = new Map<string, UnitCacheEntry>();
  /** Per-written-file line-to-slot maps for runtime-failure attribution. */
  readonly lines = new Map<string, Map<number, LineSlot>>();

  private readonly paths = new Map<string, DecisionPathEntry[]>();
  private readonly byId = new Map<number, DecisionPathEntry>();
  private readonly sources = new Map<string, string>();
  /** Validated-but-dropped search candidate bodies retained as repair candidates, keyed by (target, unit). */
  private readonly candidates = new Map<string, PythonNode[][]>();
  private readonly keptCandidates = new Map<string, number>();
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
  invalidateUnitAttempts(target: string, unit: string): void {
    this.assertActive();
    const prefix = `${target}${SEPARATOR}${unit}${SEPARATOR}`;
    for (const scope of [...this.paths.keys()]) if (scope.startsWith(prefix)) this.invalidateScope(scope);
    this.keptCandidates.delete(`${target}${SEPARATOR}${unit}`);
  }

  /**
   * The search candidate whose body was kept for one (target, unit) at width > 1. Recorded when a
   * unit validates so the line map can resolve repair through the body that was actually written
   * instead of scanning candidate scopes from zero.
   */
  recordKeptCandidate(target: string, unit: string, candidate: number): void {
    this.assertActive();
    this.keptCandidates.set(`${target}${SEPARATOR}${unit}`, candidate);
  }

  keptCandidate(target: string, unit: string): number | undefined {
    this.assertActive();
    return this.keptCandidates.get(`${target}${SEPARATOR}${unit}`);
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
   * Move everything recorded under a generation field to the concrete written path (single-file
   * writes know the path only after the tool runs). The line map, source, unit cache, generation
   * task, retained candidates, recorded decision paths, and kept-candidate scopes are all re-keyed;
   * each line slot's `target` and scope follow, so two files written through the same body field
   * can never share a cache entry, a decision path, or a repair target. A no-op when they are the
   * same.
   */
  adoptWrittenFile(from: string, to: string): void {
    this.assertActive();
    if (from === to) return;
    const fromPrefix = `${from}${SEPARATOR}`;
    const toPrefix = `${to}${SEPARATOR}`;
    const lines = this.lines.get(from);
    if (lines !== undefined) {
      this.lines.delete(from);
      for (const slot of lines.values()) {
        if (slot.target === from) slot.target = to;
        if (slot.scope?.startsWith(fromPrefix)) slot.scope = `${toPrefix}${slot.scope.slice(fromPrefix.length)}`;
      }
      this.lines.set(to, lines);
    }
    const source = this.sources.get(from);
    if (source !== undefined) {
      this.sources.delete(from);
      this.sources.set(to, source);
    }
    const units = this.units.get(from);
    if (units !== undefined) {
      this.units.delete(from);
      this.units.set(to, units);
    }
    const task = this.generationTasks.get(from);
    if (task !== undefined) {
      this.generationTasks.delete(from);
      this.generationTasks.set(to, task);
    }
    for (const key of [...this.candidates.keys()]) {
      if (!key.startsWith(fromPrefix)) continue;
      const bodies = this.candidates.get(key)!;
      this.candidates.delete(key);
      this.candidates.set(`${toPrefix}${key.slice(fromPrefix.length)}`, bodies);
    }
    for (const key of [...this.keptCandidates.keys()]) {
      if (!key.startsWith(fromPrefix)) continue;
      const candidate = this.keptCandidates.get(key)!;
      this.keptCandidates.delete(key);
      this.keptCandidates.set(`${toPrefix}${key.slice(fromPrefix.length)}`, candidate);
    }
    // Recorded decision paths move to the written target so a later generation under the same
    // field starts a fresh scope instead of overwriting this file's entries. Entries already
    // recorded for the target are superseded by the write being adopted.
    for (const key of [...this.paths.keys()]) {
      if (!key.startsWith(fromPrefix)) continue;
      const entries = this.paths.get(key)!;
      this.paths.delete(key);
      const next = `${toPrefix}${key.slice(fromPrefix.length)}`;
      const replaced = this.paths.get(next);
      if (replaced !== undefined) for (const entry of replaced) this.byId.delete(entry.decisionId);
      this.paths.set(next, entries);
    }
  }

  /**
   * Snapshot every recorded decision entry (chosen label, answer, retained alternatives). A repair
   * rebuild consumes alternatives as it commits; when its write never reaches disk the caller
   * restores the snapshot so the next repair replays the same runner-up instead of a stale one.
   */
  snapshotDecisions(): DecisionSnapshot[] {
    this.assertActive();
    return [...this.byId.values()].map(entry => ({ decisionId: entry.decisionId, chosen: entry.chosen,
      ...(entry.answer === undefined ? {} : { answer: entry.answer }), alternatives: [...entry.alternatives] }));
  }

  /** Restore entries captured by snapshotDecisions(); entries invalidated since are left invalid. */
  restoreDecisions(snapshot: readonly DecisionSnapshot[]): void {
    this.assertActive();
    for (const item of snapshot) {
      const entry = this.byId.get(item.decisionId);
      if (entry === undefined) continue;
      entry.chosen = item.chosen;
      if (item.answer === undefined) delete entry.answer;
      else entry.answer = item.answer;
      entry.alternatives = [...item.alternatives];
    }
  }

  /**
   * Replace a file's recorded source and line map, or clear them when undefined. Used to undo the
   * run-context records of a repair generation whose write failed, so a later repair is not
   * blocked by a source that never reached disk.
   */
  restoreFile(path: string, source: string | undefined, lines: ReadonlyMap<number, LineSlot> | undefined): void {
    this.assertActive();
    if (source === undefined) this.sources.delete(path);
    else this.sources.set(path, source);
    if (lines === undefined) this.lines.delete(path);
    else this.lines.set(path, new Map(lines));
  }

  /** Retain validated-but-dropped search candidates for one (target, unit) as repair candidates. */
  retainCandidates(target: string, unit: string, bodies: readonly PythonNode[][]): void {
    this.assertActive();
    if (!bodies.length) return;
    const key = `${target}${SEPARATOR}${unit}`;
    this.candidates.set(key, [...(this.candidates.get(key) ?? []), ...bodies]);
  }

  candidatesFor(target: string, unit: string): readonly PythonNode[][] {
    this.assertActive();
    return this.candidates.get(`${target}${SEPARATOR}${unit}`) ?? [];
  }

  /**
   * Snapshot the mutable generation state a repair rebuild can consume or rewrite: unit-cache
   * entries (deep-cloned, because body invalidation mutates them in place), kept-candidate indexes,
   * retained candidates, generation tasks, and the recorded decision paths. The caller restores it
   * when the rebuild's write never reaches disk, so the next repair rebuilds from the pre-rebuild
   * state instead of the failed rebuild's cache, scopes, or decisions. A snapshot is consumed by
   * one restore.
   */
  snapshotRunState(): RunStateSnapshot {
    this.assertActive();
    return {
      units: new Map([...this.units].map(([key, entry]) => [key, structuredClone(entry)])),
      keptCandidates: new Map(this.keptCandidates),
      candidates: new Map([...this.candidates].map(([key, bodies]) => [key, [...bodies]])),
      generationTasks: new Map([...this.generationTasks].map(([key, value]) => [key, { ...value }])),
      paths: new Map([...this.paths].map(([key, entries]) => [key, [...entries]])),
      byId: new Map(this.byId),
    };
  }

  /** Restore entries captured by snapshotRunState(); entries recorded since the snapshot are dropped. */
  restoreRunState(snapshot: RunStateSnapshot): void {
    this.assertActive();
    const replace = <K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void => {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    };
    replace(this.units, snapshot.units);
    replace(this.keptCandidates, snapshot.keptCandidates);
    replace(this.candidates, snapshot.candidates);
    replace(this.generationTasks, snapshot.generationTasks);
    replace(this.paths, snapshot.paths);
    replace(this.byId, snapshot.byId);
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
    this.keptCandidates.clear();
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
