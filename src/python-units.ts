import type { Decisions } from './decisions.js';
import { functionDef, node, type Builder, type PythonNode, type Scope, type Vocab } from './python-nodes.js';
import { searchUnit, type SearchHooks } from './python-search.js';
import type { RunContext } from './run-context.js';

export interface Peer { name: string; arity: number; purpose: string; module?: string }
export interface Unit extends Peer { params: string[]; def: PythonNode; body: PythonNode[] }
export interface Layout { pkg: string; modules: string[] }

export const ENTRY = 'main';
const importFrom = (module: string, id: string): PythonNode => node('ImportFrom', { module, names: [node('alias', { name: id, asname: null })], level: 0 });
const isImport = (stmt: PythonNode): boolean => stmt._type === 'Import' || stmt._type === 'ImportFrom';

const counts = (n: number, describe: (i: number) => string): Record<string, string> => Object.fromEntries(Array.from({ length: n + 1 }, (_, i) => [String(i), describe(i)]));

export async function decomposeLayout(root: Builder, scope: Scope): Promise<Layout> {
  const pkg = await root.identifier('package_name', scope, [ENTRY]);
  const count = Number(await root.pick('module_count', scope, Object.fromEntries([1, 2, 3].map(n => [String(n), `${n} module${n > 1 ? 's' : ''} inside the package ${pkg}.`]))));
  const modules: string[] = [];
  for (let i = 0; i < count; i++) modules.push(await root.identifier(`module_${i}_name`, scope, [pkg, ...modules]));
  return { pkg, modules };
}

export async function decompose(root: Builder, scope: Scope, vocab: Vocab, peers: Peer[], layout?: Layout): Promise<Unit[]> {
  if (!vocab.purposes.length) return [];
  const count = Number(await root.pick('unit_count', scope, counts(6, i => i === 0 ? 'No helper functions; write the program as one main block.' : `${i} helper function${i > 1 ? 's' : ''}, each generated on its own, then a main block that uses them.`)));
  const units: Unit[] = [];
  for (let i = 0; i < count; i++) {
    const name = await root.identifier(`unit_${i}_name`, scope, units.map(u => u.name));
    const arity = Number(await root.pick(`unit_${i}_arity`, scope, counts(3, n => `${n} positional parameter${n === 1 ? '' : 's'}.`)));
    const purpose = String(await root.terminal(`unit_${i}_purpose`, scope, vocab.purposes));
    const unitScope: Scope = { names: new Map(), parent: scope, function: true, loop: false };
    const params: string[] = [];
    for (let j = 0; j < arity; j++) { const p = await root.identifier(`unit_${i}_parameter_${j}`, unitScope, params); params.push(p); unitScope.names.set(p, { kind: 'parameter' }); }
    const body: PythonNode[] = [];
    const unit: Unit = { name, arity, purpose, params, def: functionDef(name, params.map(p => node('arg', { arg: p, annotation: null, type_comment: null })), body), body };
    if (layout) {
      const criteria: Record<string, string> = { [ENTRY]: `The entry script ${ENTRY}.py.` };
      layout.modules.forEach((m, k) => { criteria[`module_${k}`] = `Package module ${layout.pkg}/${m}.py.`; });
      const picked = await root.pick(`unit_${i}_module`, scope, criteria);
      unit.module = picked === ENTRY ? ENTRY : `${layout.pkg}.${layout.modules[Number(picked.slice(7))]!}`;
    }
    units.push(unit);
    peers.push({ name, arity, purpose, ...(unit.module === undefined ? {} : { module: unit.module }) });
  }
  return units;
}

export const isEntry = (unit: Peer): boolean => unit.module === undefined || unit.module === ENTRY;
export const peersOf = (unit: Peer, all: Peer[]): Peer[] => isEntry(unit) ? all : all.filter(p => !isEntry(p));

export type UnitSearch = Omit<SearchHooks, 'generate' | 'render' | 'check' | 'score' | 'report'> & {
  render(unit: Unit, body: PythonNode[]): Promise<string>;
  check(unit: Unit, source: string): Promise<string | undefined>;
  score(unit: Unit, decisions: Decisions, source: string, candidate: number): Promise<number>;
  report(unit: Unit, candidate: Parameters<SearchHooks['report']>[0]): Promise<void>;
};

/** A retryable static-check failure: the reason, the offending symbol when known, and a compile snippet. */
export interface UnitRepair { reason: string; symbol?: string; snippet?: string }

/** Per-unit static check used by the width-1 path, where search hooks do not run. */
export interface UnitCheck {
  render(unit: Unit, body: PythonNode[]): Promise<string>;
  /** Retryable diagnosis for a rendered unit body; undefined when the body passes. */
  check(unit: Unit, source: string): Promise<UnitRepair | undefined>;
}

/** A unit specification with its pristine, statically validated body; `body` is undefined while regeneration is required. */
export interface CachedUnit {
  name: string;
  arity: number;
  purpose: string;
  params: string[];
  module?: string;
  body: PythonNode[] | undefined;
}

/** The validated unit tree for one write target and normalized task text, stored on the run context. */
export interface UnitCacheEntry {
  /** Normalized task text the entry was validated against. */
  task: string;
  /** Package layout for project generation; absent for single-file generation. */
  layout?: Layout;
  units: CachedUnit[];
}

const clone = <T>(value: T): T => structuredClone(value);

/** Normalized task text for cache lookup: whitespace-collapsed so cosmetic edits keep reuse. */
export const normalizeUnitTask = (objective: string): string => objective.trim().replace(/\s+/g, ' ');

/** The peer view of a cached unit, for scope and criteria construction on reuse. */
export const cachedPeer = (unit: CachedUnit): Peer => ({ name: unit.name, arity: unit.arity, purpose: unit.purpose, ...(unit.module === undefined ? {} : { module: unit.module }) });

/** Restore a cached unit into a mutable generation unit with a private body clone. */
export function unitFromCached(cached: CachedUnit): Unit {
  const body = cached.body === undefined ? [] : clone(cached.body);
  return { name: cached.name, arity: cached.arity, purpose: cached.purpose, params: [...cached.params],
    ...(cached.module === undefined ? {} : { module: cached.module }),
    def: functionDef(cached.name, cached.params.map(p => node('arg', { arg: p, annotation: null, type_comment: null })), body), body };
}

/** Snapshot a generation unit for the cache; an unvalidated unit keeps its spec but no body. */
export function unitToCached(unit: Unit, validated: boolean): CachedUnit {
  return { name: unit.name, arity: unit.arity, purpose: unit.purpose, params: [...unit.params],
    ...(unit.module === undefined ? {} : { module: unit.module }), body: validated ? clone(unit.body) : undefined };
}

/**
 * Load the cache entry for a write target. A changed task text clears the entry: reuse is scoped to
 * rewrites of the same task, and an entry from another objective is dropped instead of reused.
 */
export function loadUnitCache(context: RunContext, target: string, task: string): UnitCacheEntry | undefined {
  const stored = context.units.get(target) as UnitCacheEntry | undefined;
  if (stored === undefined) return undefined;
  if (stored.task !== task) { context.units.delete(target); return undefined; }
  return stored;
}

export function saveUnitCache(context: RunContext, target: string, entry: UnitCacheEntry): void {
  context.units.set(target, entry);
}

export function dropUnitCache(context: RunContext, target: string): void {
  context.units.delete(target);
}

/** Mark cached bodies as pending regeneration (all units when `names` is omitted); returns the affected names. */
export function invalidateCachedBodies(context: RunContext, target: string, names?: Iterable<string>): string[] {
  const entry = context.units.get(target) as UnitCacheEntry | undefined;
  if (entry === undefined) return [];
  const wanted = names === undefined ? undefined : new Set(names);
  const affected: string[] = [];
  for (const unit of entry.units) {
    if (wanted !== undefined && !wanted.has(unit.name)) continue;
    if (unit.body === undefined) continue;
    unit.body = undefined;
    affected.push(unit.name);
  }
  return affected;
}

export type UnitStartHook = (unit: Unit) => void;
/** Called once per unit whose body passed its final static check, so it may be cached for reuse. */
export type UnitValidatedHook = (unit: Unit) => void;

/**
 * Width 1: generate the body, run the per-unit static check before assembly, and retry once in
 * place with the reason (and symbol) in state and criteria narrowed by the failure kind. A second
 * retryable failure aborts the pool; fatal errors (provider, limit, render) never retry.
 * Width > 1 keeps the search-hooks path, where static failures are handled by candidate pruning.
 */
export async function fillUnits(units: Unit[], decisions: Decisions, makeBuilder: (unit: Unit, fork: Decisions, candidate?: number, body?: PythonNode[], repair?: UnitRepair) => Builder, parentFor: (unit: Unit) => Scope, check?: UnitCheck, search?: UnitSearch, onUnitStart?: UnitStartHook, onUnitValidated?: UnitValidatedHook): Promise<void> {
  const controller = new AbortController();
  const scopeFor = (unit: Unit): Scope => ({ names: new Map(unit.params.map(p => [p, { kind: 'parameter' as const }])), parent: parentFor(unit), function: true, loop: false });
  const outcomes = await Promise.allSettled(units.map(async unit => {
    try {
      onUnitStart?.(unit);
      const fork = decisions.fork(controller.signal);
      if (search && search.width > 1) {
        await searchUnit(unit, fork, {
          width: search.width,
          generate: (candidateFork, body, candidate) => makeBuilder(unit, candidateFork, candidate, body).block(body, scopeFor(unit), 1, 'function_body'),
          render: body => search.render(unit, body), check: source => search.check(unit, source),
          score: (d, source, candidate) => search.score(unit, d, source, candidate), report: candidate => search.report(unit, candidate),
        });
        onUnitValidated?.(unit);
        return;
      }
      await makeBuilder(unit, fork).block(unit.body, scopeFor(unit), 1, 'function_body');
      if (!check) return;
      const source = await check.render(unit, unit.body);
      const first = await check.check(unit, source);
      if (first === undefined) { onUnitValidated?.(unit); return; }
      unit.body.length = 0;
      const repair: UnitRepair = { reason: first.reason, ...(first.symbol === undefined ? {} : { symbol: first.symbol }), ...(first.reason === 'compile' ? { snippet: source.slice(0, 1200) } : {}) };
      await makeBuilder(unit, decisions.fork(controller.signal), undefined, undefined, repair).block(unit.body, scopeFor(unit), 1, 'function_body');
      const second = await check.check(unit, await check.render(unit, unit.body));
      if (second !== undefined) throw new Error(`Unit ${unit.name}: static check failed twice (${first.reason} then ${second.reason}); the write is aborted.`);
      onUnitValidated?.(unit);
    } catch (err) { controller.abort(err); throw err; }
  }));
  const failure = outcomes.find(o => o.status === 'rejected');
  if (failure?.status === 'rejected') throw controller.signal.reason ?? failure.reason;
}

export function assemble(tree: PythonNode, units: Unit[]): void {
  const body = tree.body as PythonNode[];
  const defs = new Set<PythonNode>(units.map(u => u.def));
  const main = body.filter(stmt => !defs.has(stmt));
  const imports = main.filter(isImport);
  tree.body = [...imports, ...units.map(u => u.def), ...main.filter(stmt => !imports.includes(stmt))];
}

function calledUnits(value: unknown, byName: Map<string, Unit>, out: Set<Unit>): void {
  if (Array.isArray(value)) { for (const item of value) calledUnits(item, byName, out); return; }
  if (!value || typeof value !== 'object') return;
  const ast = value as PythonNode;
  if (ast._type === 'Call') {
    const func = ast.func as PythonNode | undefined;
    if (func?._type === 'Name') { const unit = byName.get(String(func.id)); if (unit) out.add(unit); }
  }
  for (const [key, child] of Object.entries(ast)) if (key !== '_type') calledUnits(child, byName, out);
}

/** Names of units in `units` that call `unit` or are called by it, using the peer call graph. */
export function dependentNames(unit: Unit, units: readonly Unit[]): string[] {
  const byName = new Map(units.map(candidate => [candidate.name, candidate]));
  const names = new Set<string>();
  const callees = new Set<Unit>();
  calledUnits(unit.body, byName, callees);
  for (const callee of callees) if (callee.name !== unit.name) names.add(callee.name);
  for (const other of units) {
    if (other.name === unit.name) continue;
    const called = new Set<Unit>();
    calledUnits(other.body, byName, called);
    if ([...called].some(candidate => candidate.name === unit.name)) names.add(other.name);
  }
  return [...names].sort();
}

/**
 * Commit-time dependency rule for a repaired unit: the repaired body replaces its cached body, and
 * every unit that calls it or is called by it is invalidated, so the next rewrite regenerates
 * exactly that dependency set. A no-op without a cache entry; returns the invalidated dependent names.
 */
export function commitRepairedUnit(context: RunContext, target: string, repaired: Unit, units: readonly Unit[]): string[] {
  const entry = context.units.get(target) as UnitCacheEntry | undefined;
  if (entry === undefined) return [];
  const cached = entry.units.find(candidate => candidate.name === repaired.name);
  if (cached !== undefined) cached.body = clone(repaired.body);
  const present = new Set(entry.units.map(candidate => candidate.name));
  const dependents = dependentNames(repaired, units).filter(name => present.has(name));
  invalidateCachedBodies(context, target, dependents);
  return dependents;
}

const crossImports = (from: string, stmts: PythonNode[], byName: Map<string, Unit>): PythonNode[] => {
  const called = new Set<Unit>();
  calledUnits(stmts, byName, called);
  return [...called].filter(u => u.module !== from).sort((a, b) => a.module!.localeCompare(b.module!) || a.name.localeCompare(b.name)).map(u => importFrom(u.module!, u.name));
};

export function assembleProject(tree: PythonNode, units: Unit[], layout: Layout): Record<string, PythonNode> {
  const byName = new Map(units.map(u => [u.name, u]));
  // Body-level imports are added to a private def copy so cached unit bodies stay pristine for reuse.
  const defOf = (unit: Unit): PythonNode => {
    const imports = crossImports(unit.module!, unit.body, byName);
    return imports.length ? functionDef(unit.name, unit.params.map(p => node('arg', { arg: p, annotation: null, type_comment: null })), [...imports, ...unit.body]) : unit.def;
  };
  const defs = new Set<PythonNode>(units.map(u => u.def));
  const main = (tree.body as PythonNode[]).filter(stmt => !defs.has(stmt));
  const stmts = main.filter(stmt => !isImport(stmt));
  const guard = node('If', { test: node('Compare', { left: node('Name', { id: '__name__', ctx: node('Load') }), ops: [node('Eq')], comparators: [node('Constant', { value: '__main__', kind: null })] }), body: stmts.length ? stmts : [node('Pass')], orelse: [] });
  const entry = [...main.filter(isImport), ...crossImports(ENTRY, stmts, byName), ...units.filter(u => u.module === ENTRY).map(defOf), guard];
  const files: Record<string, PythonNode> = { [`${layout.pkg}/__init__.py`]: node('Module', { body: [], type_ignores: [] }) };
  for (const m of layout.modules) {
    const defs = units.filter(u => u.module === `${layout.pkg}.${m}`).map(defOf);
    if (defs.length) files[`${layout.pkg}/${m}.py`] = node('Module', { body: defs, type_ignores: [] });
  }
  files[`${ENTRY}.py`] = node('Module', { body: entry, type_ignores: [] });
  return files;
}
