import type { Decisions } from './decisions.js';
import type { Builder, PythonNode, Scope, Vocab } from './python-ast.js';

export interface Peer { name: string; arity: number; purpose: string }
export interface Unit extends Peer { params: string[]; def: PythonNode; body: PythonNode[] }

const node = (_type: string, fields: Record<string, unknown> = {}): PythonNode => ({ _type, ...fields });
const functionDef = (id: string, params: string[], body: PythonNode[]): PythonNode =>
  node('FunctionDef', { name: id, args: node('arguments', { posonlyargs: [], args: params.map(p => node('arg', { arg: p, annotation: null, type_comment: null })), vararg: null, kwonlyargs: [], kw_defaults: [], kwarg: null, defaults: [] }), body, decorator_list: [], returns: null, type_comment: null, type_params: [] });

const counts = (n: number, describe: (i: number) => string): Record<string, string> => Object.fromEntries(Array.from({ length: n + 1 }, (_, i) => [String(i), describe(i)]));

export async function decompose(root: Builder, scope: Scope, vocab: Vocab, peers: Peer[]): Promise<Unit[]> {
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
    const unit: Unit = { name, arity, purpose, params, def: functionDef(name, params, body), body };
    units.push(unit);
    peers.push({ name, arity, purpose });
  }
  return units;
}

export async function fillUnits(units: Unit[], decisions: Decisions, makeBuilder: (unit: Unit, fork: Decisions) => Builder, parent: Scope): Promise<void> {
  const controller = new AbortController();
  const outcomes = await Promise.allSettled(units.map(async unit => {
    try {
      const scope: Scope = { names: new Map(unit.params.map(p => [p, { kind: 'parameter' as const }])), parent, function: true, loop: false };
      await makeBuilder(unit, decisions.fork(controller.signal)).block(unit.body, scope, 1, 'function_body');
    } catch (err) { controller.abort(err); throw err; }
  }));
  const failure = outcomes.find(o => o.status === 'rejected');
  if (failure?.status === 'rejected') throw controller.signal.reason ?? failure.reason;
}

export function assemble(tree: PythonNode, units: Unit[]): void {
  const body = tree.body as PythonNode[];
  const defs = new Set<PythonNode>(units.map(u => u.def));
  const main = body.filter(stmt => !defs.has(stmt));
  const imports = main.filter(stmt => stmt._type === 'Import' || stmt._type === 'ImportFrom');
  tree.body = [...imports, ...units.map(u => u.def), ...main.filter(stmt => !imports.includes(stmt))];
}
