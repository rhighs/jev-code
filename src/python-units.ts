import type { Decisions } from './decisions.js';
import { functionDef, node, type Builder, type PythonNode, type Scope, type Vocab } from './python-ast.js';
import { searchUnit, type SearchHooks } from './python-search.js';

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

export async function fillUnits(units: Unit[], decisions: Decisions, makeBuilder: (unit: Unit, fork: Decisions, candidate?: number, body?: PythonNode[]) => Builder, parentFor: (unit: Unit) => Scope, search?: UnitSearch): Promise<void> {
  const controller = new AbortController();
  const scopeFor = (unit: Unit): Scope => ({ names: new Map(unit.params.map(p => [p, { kind: 'parameter' as const }])), parent: parentFor(unit), function: true, loop: false });
  const outcomes = await Promise.allSettled(units.map(async unit => {
    try {
      const fork = decisions.fork(controller.signal);
      if (search && search.width > 1) {
        await searchUnit(unit, fork, {
          width: search.width,
          generate: (candidateFork, body, candidate) => makeBuilder(unit, candidateFork, candidate, body).block(body, scopeFor(unit), 1, 'function_body'),
          render: body => search.render(unit, body), check: source => search.check(unit, source),
          score: (d, source, candidate) => search.score(unit, d, source, candidate), report: candidate => search.report(unit, candidate),
        });
      } else await makeBuilder(unit, fork).block(unit.body, scopeFor(unit), 1, 'function_body');
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

const crossImports = (from: string, stmts: PythonNode[], byName: Map<string, Unit>): PythonNode[] => {
  const called = new Set<Unit>();
  calledUnits(stmts, byName, called);
  return [...called].filter(u => u.module !== from).sort((a, b) => a.module!.localeCompare(b.module!) || a.name.localeCompare(b.name)).map(u => importFrom(u.module!, u.name));
};

export function assembleProject(tree: PythonNode, units: Unit[], layout: Layout): Record<string, PythonNode> {
  const byName = new Map(units.map(u => [u.name, u]));
  for (const unit of units) unit.body.unshift(...crossImports(unit.module!, unit.body, byName));
  const defs = new Set<PythonNode>(units.map(u => u.def));
  const main = (tree.body as PythonNode[]).filter(stmt => !defs.has(stmt));
  const stmts = main.filter(stmt => !isImport(stmt));
  const guard = node('If', { test: node('Compare', { left: node('Name', { id: '__name__', ctx: node('Load') }), ops: [node('Eq')], comparators: [node('Constant', { value: '__main__', kind: null })] }), body: stmts.length ? stmts : [node('Pass')], orelse: [] });
  const entry = [...main.filter(isImport), ...crossImports(ENTRY, stmts, byName), ...units.filter(u => u.module === ENTRY).map(u => u.def), guard];
  const files: Record<string, PythonNode> = { [`${layout.pkg}/__init__.py`]: node('Module', { body: [], type_ignores: [] }) };
  for (const m of layout.modules) {
    const defs = units.filter(u => u.module === `${layout.pkg}.${m}`).map(u => u.def);
    if (defs.length) files[`${layout.pkg}/${m}.py`] = node('Module', { body: defs, type_ignores: [] });
  }
  files[`${ENTRY}.py`] = node('Module', { body: entry, type_ignores: [] });
  return files;
}
