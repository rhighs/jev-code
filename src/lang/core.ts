import { choice } from '@typesafe-ai/sdk';
import type { AstAdapter } from '../ast-adapters.js';
import { buildDecisionContext, PENDING, windowSource } from '../decision-context.js';
import type { Decisions, State } from '../decisions.js';
import type { GenerateOptions } from '../generation.js';
import { gridCursor } from '../grid.js';
import { compactContext, MAX_GRID_REQUEST_BYTES } from '../scored-grid.js';
import { LimitError } from '../types.js';

export type ValueType = 'string' | 'number' | 'bool' | 'list' | 'unknown';
export type BinOp = 'add' | 'sub' | 'mul' | 'div' | 'mod' | 'concat';
export type CmpOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

export type Expr =
  | { kind: 'hole' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'name'; id: string }
  | { kind: 'binary'; op: BinOp; left: Expr; right: Expr }
  | { kind: 'compare'; op: CmpOp; left: Expr; right: Expr }
  | { kind: 'call'; callee: string; args: Expr[] }
  | { kind: 'list'; items: Expr[] }
  | { kind: 'index'; target: Expr; index: Expr };

export type Stmt =
  | { kind: 'hole' }
  | { kind: 'print'; value: Expr }
  | { kind: 'expr'; value: Expr }
  | { kind: 'assign'; id: string; value: Expr; declare: boolean; type: ValueType }
  | { kind: 'if'; test: Expr; body: Stmt[]; orelse: Stmt[] }
  | { kind: 'while'; test: Expr; body: Stmt[] }
  | { kind: 'range'; id: string; start: Expr; stop: Expr; body: Stmt[] }
  | { kind: 'foreach'; id: string; iterable: Expr; body: Stmt[]; type: ValueType }
  | { kind: 'return'; value?: Expr }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'function'; id: string; params: string[]; paramTypes: ValueType[]; returns: ValueType | 'void'; body: Stmt[] };

export interface Program { body: Stmt[] }

export interface Builtin { arity: number[]; returns: ValueType; params?: ValueType[] }
export interface Symbol { kind: 'variable' | 'parameter' | 'function' | 'builtin'; type: ValueType; arity?: number; returns?: ValueType | 'void'; readonly?: boolean }
export interface Scope { names: Map<string, Symbol>; parent?: Scope; function: boolean; loop: boolean; returnTypes?: Set<ValueType | 'void'> }

export interface Features { functions: boolean; while: boolean; range: boolean; foreach: boolean; list: boolean; index: boolean; compareStrings: boolean; concat: boolean }

export interface Dialect {
  id: string;
  extensions: string[];
  languages: string[];
  name: string;
  keywords: Set<string>;
  builtins: Record<string, Builtin>;
  features: Features;
  /** Typed dialects only build expressions whose type is inferable, so declarations can be typed. */
  typed: boolean;
  render(program: Program): string;
  validate(source: string, signal: AbortSignal): Promise<void>;
}

export const PENDING_EXPR: Expr = { kind: 'hole' };
export const isPending = (id: string): boolean => id === PENDING;

const maxBlockStatements = 16;
const maxDepth = 6;

const table = (scope: Scope, builtins: Record<string, Builtin>): Record<string, Symbol> => ({
  ...(scope.parent ? table(scope.parent, builtins) : Object.fromEntries(Object.entries(builtins).map(([id, b]) => [id, { kind: 'builtin', type: 'unknown', returns: b.returns } satisfies Symbol]))),
  ...Object.fromEntries(scope.names),
});
const visible = (scope: Scope, builtins: Record<string, Builtin>): string[] => Object.keys(table(scope, builtins));

export function typeOf(expr: Expr, symbols: Record<string, Symbol>): ValueType {
  switch (expr.kind) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'bool': return 'bool';
    case 'list': return 'list';
    case 'compare': return 'bool';
    case 'binary': return expr.op === 'concat' || typeOf(expr.left, symbols) === 'string' || typeOf(expr.right, symbols) === 'string' ? 'string' : 'number';
    case 'name': return symbols[expr.id]?.type ?? 'unknown';
    case 'call': { const r = symbols[expr.callee]?.returns; return r === undefined || r === 'void' ? 'unknown' : r; }
    case 'index': return 'unknown';
    case 'hole': return 'unknown';
  }
}

export interface Vocab { identifiers: string[]; strings: string[]; numbers: number[]; words: string[] }

export function vocabulary(objective: string, keywords: Set<string>): Vocab {
  const words = objective.match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? [];
  const identifiers = [...new Set([...words.filter(w => /^[a-z_][a-z_0-9]*$/.test(w) && !keywords.has(w)), 'message', 'result', 'value', 'i', 'n', 'total', 'count', 'name', 'items', 'a', 'b', 'x', 'y'])].slice(0, 180);
  const quoted = [...objective.matchAll(/`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/g)].map(m => m[1] ?? m[2] ?? m[3]!);
  const literals: string[] = [...quoted];
  for (let start = 0; start < words.length; start++) for (let count = 1; count <= 3 && start + count <= words.length; count++) {
    const phrase = words.slice(start, start + count).join(' ');
    const capital = phrase[0]!.toUpperCase() + phrase.slice(1);
    literals.push(phrase, capital, capital + '!');
    if (count > 1) literals.push(words[start]![0]!.toUpperCase() + words[start]!.slice(1) + ', ' + words.slice(start + 1, start + count).join(' ') + '!');
  }
  const strings = [...new Set(literals)].slice(0, 220);
  const numbers = [...new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 50, 100, 1000, -1, ...((objective.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number))])].filter(Number.isFinite).slice(0, 200);
  return { identifiers, strings, numbers, words };
}

export async function generateProgram(dialect: Dialect, decisions: Decisions, state: State, field: string, options: GenerateOptions): Promise<string> {
  const task = state.task as { prompt?: string; updates?: string[] } | undefined;
  const objective = [task?.prompt ?? '', ...(task?.updates ?? [])].join('\n');
  const context = compactContext(state);
  const vocab = vocabulary(objective, dialect.keywords);
  const { builtins, features, typed } = dialect;
  const program: Program = { body: [] };
  let step = 0;

  const render = (): string => dialect.render(program);

  async function pick(slot: string, scope: Scope, criteria: Record<string, string>, depth = 0): Promise<string> {
    decisions.signal.throwIfAborted();
    if (++step > options.maxSteps) throw new LimitError(`${dialect.name} AST production budget exhausted (${options.maxSteps}).`);
    const keys = Object.keys(criteria);
    if (!keys.length) throw new Error(`No valid ${dialect.name} AST production for ${slot}.`);
    const preview = render();
    const instruction = `Choose the next valid ${dialect.name} AST production for ${slot}. The rendered source marks the slot being filled with ${PENDING}. Satisfy the objective with the smallest sufficient program. Complete the current slot only; do not add unrequested behavior.`;
    const symbols = visible(scope, builtins);
    const questions = { selection: choice(instruction, criteria) };
    const core = { field, phase: 'ast', slot, symbols, symbolTable: table(scope, builtins), language: dialect.id,
      constraints: { depth, maxDepth, inFunction: scope.function, inLoop: scope.loop, remainingSteps: options.maxSteps - step } };
    const assemble = (values: Record<string, unknown>): State => ({
      task: values.task, ...(values.recent === undefined ? {} : { recent: values.recent }), ...(values.plan === undefined ? {} : { plan: values.plan }),
      generation: { ...core, partialSource: values.source, ...(values.trimmed === undefined ? {} : { trimmed: values.trimmed }) },
    });
    const { values, trimmed } = buildDecisionContext([
      { key: 'task', value: { prompt: objective }, required: true },
      { key: 'core', value: core, required: true },
      { key: 'source', value: preview, shrink: windowSource },
      { key: 'recent', value: context.recent ?? [] },
      ...(typeof context.plan === 'string' && context.plan ? [{ key: 'plan', value: context.plan }] : []),
    ], parts => Buffer.byteLength(JSON.stringify({ state: assemble(parts), questions })), MAX_GRID_REQUEST_BYTES);
    const selected = keys.length === 1 ? keys[0]! : await decisions.choose(assemble(trimmed.length ? { ...values, trimmed } : values), instruction, criteria);
    await options.onText?.(field, preview, false, { replace: preview }, { decoder: 'ast', step, cursor: gridCursor(preview), bytes: Buffer.byteLength(preview), ast: { slot, production: selected, symbols } });
    return selected;
  }

  async function terminal(slot: string, scope: Scope, values: Array<string | number>): Promise<string | number> {
    const criteria: Record<string, string> = Object.fromEntries(values.map((value, index) => [`value_${index}`, JSON.stringify(value)]));
    if (slot === 'string') criteria.custom = 'Compose a different string from valid token choices.';
    const selected = await pick(slot, scope, criteria);
    if (selected !== 'custom') return values[Number(selected.slice(6))]!;
    const pieces = [...new Set([...vocab.words, ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split(''), ' ', ', ', ': ', '!', '?', '.'])].slice(0, 240);
    let result = '', last = '', repeats = 0;
    for (let count = 0; count < 32; count++) {
      const candidates: Record<string, string> = Object.fromEntries(pieces.map((piece, index) => [`piece_${index}`, JSON.stringify(piece)]));
      candidates.end = 'This string is complete.';
      const choice = await pick(`string_token:${JSON.stringify(result)}`, scope, candidates);
      if (choice === 'end') return result;
      const piece = pieces[Number(choice.slice(6))]!;
      repeats = piece === last ? repeats + 1 : 1;
      last = piece;
      result += piece;
      if (Buffer.byteLength(result) > 2000) throw new LimitError('AST string exceeds its byte budget.');
      if (repeats >= 3) return result;
    }
    throw new LimitError('AST string token budget exhausted.');
  }

  async function identifier(slot: string, scope: Scope, exclude: string[] = []): Promise<string> {
    const taken = new Set([...exclude, ...Object.keys(builtins)]);
    const value = String(await terminal(slot, scope, vocab.identifiers.filter(id => !taken.has(id))));
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(value) || dialect.keywords.has(value) || taken.has(value)) throw new Error(`Invalid ${dialect.name} identifier: ${value}`);
    return value;
  }

  const fits = (expect: ValueType | undefined, actual: ValueType): boolean => expect === undefined || expect === 'unknown' || actual === expect || (!typed && actual === 'unknown');

  async function expression(set: (e: Expr) => void, scope: Scope, depth: number, slot = 'expression', expect?: ValueType, calls = 0, avoid?: string, nonzero = false): Promise<Expr> {
    const symbols = table(scope, builtins);
    const namesForValue = Object.entries(symbols).filter(([, s]) => s.kind !== 'builtin' && s.kind !== 'function').map(([id]) => id).filter(id => id !== avoid && fits(expect, symbols[id]!.type));
    const callable = Object.entries(symbols).filter(([, s]) => (s.kind === 'builtin' || s.kind === 'function') && s.returns !== 'void' && fits(expect, s.returns === undefined ? 'unknown' : s.returns)).map(([id]) => id);
    const criteria: Record<string, string> = {};
    if (fits(expect, 'string')) criteria.string = 'A literal string.';
    if (fits(expect, 'number')) criteria.number = 'A numeric literal.';
    if (fits(expect, 'bool')) criteria.boolean = 'A boolean literal.';
    if (namesForValue.length) criteria.name = 'Reference an already defined variable or parameter.';
    if (depth < maxDepth && fits(expect, 'number')) criteria.binary = 'Combine two numeric expressions with arithmetic.';
    if (depth < maxDepth && features.concat && fits(expect, 'string')) criteria.concat = 'Join two strings.';
    if (depth < maxDepth && fits(expect, 'bool')) criteria.compare = 'Compare two expressions.';
    if (depth < maxDepth && calls < 2 && callable.length) criteria.call = 'Call a function with arguments.';
    if (features.list && fits(expect, 'list') && (expect === 'list' || (depth < maxDepth && !slot.startsWith('element_') && !slot.startsWith('argument_')))) criteria.list = 'A list of expressions.';
    if (depth < maxDepth && features.index && !typed) criteria.index = 'Index a defined list.';
    if (!Object.keys(criteria).length) throw new Error(`No ${dialect.name} expression can produce a ${expect ?? 'value'} here.`);
    const production = await pick(slot, scope, criteria, depth);
    let expr: Expr;
    if (production === 'string') expr = { kind: 'string', value: String(await terminal('string', scope, vocab.strings)) };
    else if (production === 'number') expr = { kind: 'number', value: Number(await terminal('number', scope, nonzero ? vocab.numbers.filter(n => n !== 0) : vocab.numbers)) };
    else if (production === 'boolean') expr = { kind: 'bool', value: await pick('singleton', scope, { true: 'true', false: 'false' }) === 'true' };
    else if (production === 'name') {
      const selected = await pick('reference', scope, Object.fromEntries(namesForValue.map((id, i) => [`name_${i}`, id])));
      expr = { kind: 'name', id: namesForValue[Number(selected.slice(5))]! };
    } else if (production === 'call') {
      const selected = await pick('callee', scope, Object.fromEntries(callable.map((id, i) => [`name_${i}`, id])));
      const callee = callable[Number(selected.slice(5))]!;
      const symbol = symbols[callee]!;
      const counts = symbol.arity !== undefined ? [symbol.arity] : builtins[callee]?.arity ?? [0, 1, 2];
      const args: Expr[] = [];
      expr = { kind: 'call', callee, args };
      set(expr);
      const count = counts.length === 1 ? counts[0]! : Number(await pick('argument_count', scope, Object.fromEntries(counts.map(c => [String(c), `${c} arguments.`]))));
      for (let i = 0; i < count; i++) {
        args.push(PENDING_EXPR);
        const paramType = symbol.kind === 'builtin' ? builtins[callee]?.params?.[i] : 'number';
        await expression(e => { args[i] = e; }, scope, depth + 1, `argument_${i}`, typed ? paramType ?? 'number' : paramType, calls + 1);
      }
      return expr;
    } else if (production === 'binary' || production === 'compare' || production === 'concat') {
      const ops = production === 'binary' ? { add: 'addition +', sub: 'subtraction -', mul: 'multiplication *', div: 'division /', mod: 'remainder %' }
        : production === 'compare' ? { eq: 'equal', ne: 'not equal', lt: 'less than', le: 'less or equal', gt: 'greater than', ge: 'greater or equal' } : { concat: 'join' };
      const op = Object.keys(ops).length === 1 ? 'concat' : await pick('operator', scope, ops);
      const node: Expr = production === 'compare' ? { kind: 'compare', op: op as CmpOp, left: PENDING_EXPR, right: PENDING_EXPR } : { kind: 'binary', op: op as BinOp, left: PENDING_EXPR, right: PENDING_EXPR };
      set(node);
      const operand: ValueType | undefined = production === 'concat' ? 'string' : production === 'binary' ? 'number' : typed ? 'number' : undefined;
      const left = await expression(e => { node.left = e; }, scope, depth + 1, 'left', operand, calls);
      const rightType = production === 'compare' && !typed ? (features.compareStrings ? typeOf(left, symbols) : 'number') : operand;
      await expression(e => { node.right = e; }, scope, depth + 1, 'right', rightType === 'unknown' ? undefined : rightType, calls, undefined, op === 'div' || op === 'mod');
      return node;
    } else if (production === 'list') {
      const items: Expr[] = [];
      expr = { kind: 'list', items };
      set(expr);
      const count = Number(await pick('element_count', scope, { '0': 'Empty list.', '1': 'One element.', '2': 'Two elements.', '3': 'Three elements.' }));
      let itemType: ValueType | undefined;
      for (let i = 0; i < count; i++) {
        items.push(PENDING_EXPR);
        const item = await expression(e => { items[i] = e; }, scope, depth + 1, `element_${i}`, itemType, calls);
        itemType ??= typeOf(item, symbols) === 'unknown' ? undefined : typeOf(item, symbols);
      }
      return expr;
    } else {
      const node: Expr = { kind: 'index', target: PENDING_EXPR, index: PENDING_EXPR };
      set(node);
      await expression(e => { node.target = e; }, scope, depth + 1, 'object', 'list', calls);
      await expression(e => { node.index = e; }, scope, depth + 1, 'index', 'number', calls);
      return node;
    }
    set(expr);
    return expr;
  }

  async function block(body: Stmt[], scope: Scope, depth: number, slot: string): Promise<boolean> {
    while (body.length < maxBlockStatements) {
      const criteria: Record<string, string> = { print: 'Print an expression on its own line.', assign: 'Assign a value to a variable.' };
      const symbols = table(scope, builtins);
      if (Object.values(symbols).some(s => s.kind === 'function' || (s.kind === 'builtin' && s.returns === 'void'))) criteria.expr = 'Call a function for its effect.';
      if (body.length || (slot === 'module_body' && options.allowEmpty)) criteria.finish = 'This block satisfies its required behavior; finish it now.';
      if (scope.function) criteria.return = 'Return a value from this function.';
      if (scope.loop) { criteria.break = 'Break from the enclosing loop.'; criteria.continue = 'Continue the enclosing loop.'; }
      if (depth < maxDepth) {
        criteria.if = 'Conditional statement.';
        if (features.range) criteria.range = 'Count from a start number up to, but not including, a stop number.';
        if (features.foreach && !typed) criteria.foreach = 'Loop over the items of a list.';
        if (features.while) criteria.while = 'While loop.';
        if (features.functions && slot === 'module_body') criteria.function = 'Define a named function.';
      }
      const production = await pick(slot, scope, criteria, depth);
      if (production === 'finish') return false;
      const at = body.length;
      body.push({ kind: 'hole' });
      const put = (s: Stmt): void => { body[at] = s; };
      if (production === 'print' || production === 'expr') {
        const node: Extract<Stmt, { kind: 'print' | 'expr' }> = { kind: production, value: PENDING_EXPR };
        put(node);
        if (production === 'expr') {
          const callable = Object.entries(symbols).filter(([, s]) => s.kind === 'function' || (s.kind === 'builtin' && s.returns === 'void')).map(([id]) => id);
          const selected = await pick('callee', scope, Object.fromEntries(callable.map((id, i) => [`name_${i}`, id])));
          const callee = callable[Number(selected.slice(5))]!;
          const args: Expr[] = [];
          const call: Expr = { kind: 'call', callee, args };
          node.value = call;
          const counts = symbols[callee]!.arity !== undefined ? [symbols[callee]!.arity!] : builtins[callee]?.arity ?? [0, 1, 2];
          const count = counts.length === 1 ? counts[0]! : Number(await pick('argument_count', scope, Object.fromEntries(counts.map(c => [String(c), `${c} arguments.`]))));
          for (let i = 0; i < count; i++) {
            args.push(PENDING_EXPR);
            const paramType = symbols[callee]!.kind === 'builtin' ? builtins[callee]?.params?.[i] : 'number';
            await expression(e => { args[i] = e; }, scope, depth + 1, `argument_${i}`, typed ? paramType ?? 'number' : paramType, 1);
          }
        } else await expression(e => { node.value = e; }, scope, depth + 1, 'printed');
      } else if (production === 'assign') {
        const existing = Object.entries(symbols).filter(([, s]) => s.kind === 'variable' && !s.readonly).map(([id]) => id);
        const choiceCriteria: Record<string, string> = { new: 'Declare a new variable.' };
        for (const [i, id] of existing.entries()) choiceCriteria[`name_${i}`] = `Reassign ${id}.`;
        const target = existing.length ? await pick('assignment_target', scope, choiceCriteria) : 'new';
        const declare = target === 'new';
        const id = declare ? await identifier('assignment_name', scope, Object.keys(symbols)) : existing[Number(target.slice(5))]!;
        const node: Stmt = { kind: 'assign', id, value: PENDING_EXPR, declare, type: declare ? 'unknown' : symbols[id]!.type };
        put(node);
        const value = await expression(e => { node.value = e; }, scope, depth + 1, 'value', declare ? undefined : (symbols[id]!.type === 'unknown' ? undefined : symbols[id]!.type), 0, declare ? undefined : id);
        node.type = typeOf(value, symbols);
        if (typed && node.type === 'unknown') throw new Error(`${dialect.name} cannot infer the type of ${id}.`);
        if (declare) scope.names.set(id, { kind: 'variable', type: node.type });
      } else if (production === 'return') {
        const node: Stmt = { kind: 'return', value: PENDING_EXPR };
        put(node);
        const value = await expression(e => { node.value = e; }, scope, depth + 1, 'returned', typed ? (scope.returnTypes?.size ? [...scope.returnTypes][0] as ValueType : 'number') : undefined);
        scope.returnTypes?.add(typeOf(value, symbols));
        return true;
      } else if (production === 'break' || production === 'continue') { put({ kind: production }); return true; }
      else if (production === 'function') {
        const id = await identifier('function_name', scope, Object.keys(symbols));
        const params: string[] = [], nested: Stmt[] = [];
        const node: Stmt = { kind: 'function', id, params, paramTypes: [], returns: 'void', body: nested };
        put(node);
        const count = Number(await pick('parameter_count', scope, { '0': 'No parameters.', '1': 'One parameter.', '2': 'Two parameters.', '3': 'Three parameters.' }));
        const globals: Scope = { names: new Map([...scope.names].filter(([, s]) => s.kind === 'function')), function: false, loop: false };
        const child: Scope = { names: new Map(), parent: globals, function: true, loop: false, returnTypes: new Set() };
        for (let i = 0; i < count; i++) {
          const p = await identifier(`parameter_${i}`, child, [...params, ...Object.keys(symbols)]);
          params.push(p);
          node.paramTypes.push(typed ? 'number' : 'unknown');
          child.names.set(p, { kind: 'parameter', type: typed ? 'number' : 'unknown' });
        }
        const ended = await block(nested, child, depth + 1, 'function_body');
        const returned = [...child.returnTypes!].filter(t => t !== 'void');
        node.returns = returned.length ? returned[0]! : 'void';
        if (node.returns !== 'void' && !ended) nested.push({ kind: 'return', value: node.returns === 'string' ? { kind: 'string', value: '' } : node.returns === 'bool' ? { kind: 'bool', value: false } : { kind: 'number', value: 0 } });
        scope.names.set(id, { kind: 'function', type: 'unknown', arity: count, returns: node.returns });
      } else if (production === 'range') {
        const id = await identifier('loop_variable', scope, Object.keys(symbols));
        const nested: Stmt[] = [];
        const node: Stmt = { kind: 'range', id, start: PENDING_EXPR, stop: PENDING_EXPR, body: nested };
        put(node);
        await expression(e => { node.start = e; }, scope, depth + 1, 'start', 'number');
        await expression(e => { node.stop = e; }, scope, depth + 1, 'stop', 'number');
        await block(nested, { names: new Map([[id, { kind: 'variable', type: 'number', readonly: true }]]), parent: scope, function: scope.function, loop: true, ...(scope.returnTypes ? { returnTypes: scope.returnTypes } : {}) }, depth + 1, 'loop_body');
      } else if (production === 'foreach') {
        const id = await identifier('loop_variable', scope, Object.keys(symbols));
        const nested: Stmt[] = [];
        const node: Stmt = { kind: 'foreach', id, iterable: PENDING_EXPR, body: nested, type: 'unknown' };
        put(node);
        await expression(e => { node.iterable = e; }, scope, depth + 1, 'iterable', 'list');
        await block(nested, { names: new Map([[id, { kind: 'variable', type: 'unknown', readonly: true }]]), parent: scope, function: scope.function, loop: true, ...(scope.returnTypes ? { returnTypes: scope.returnTypes } : {}) }, depth + 1, 'loop_body');
      } else {
        const nested: Stmt[] = [];
        const orelse: Stmt[] = [];
        const node: Extract<Stmt, { kind: 'if' | 'while' }> = production === 'if' ? { kind: 'if', test: PENDING_EXPR, body: nested, orelse } : { kind: 'while', test: PENDING_EXPR, body: nested };
        put(node);
        await expression(e => { node.test = e; }, scope, depth + 1, 'condition', 'bool');
        const inner = (): Scope => ({ names: new Map(), parent: scope, function: scope.function, loop: production === 'while' || scope.loop, ...(scope.returnTypes ? { returnTypes: scope.returnTypes } : {}) });
        const ended = await block(nested, inner(), depth + 1, production === 'if' ? 'if_body' : 'loop_body');
        if (production === 'if' && await pick('else_branch', scope, { no: 'No else branch is required.', yes: 'Add an else branch.' }) === 'yes' && await block(orelse, inner(), depth + 1, 'else_body') && ended) return true;
      }
    }
    return false;
  }

  await block(program.body, { names: new Map(), function: false, loop: false }, 0, 'module_body');
  const source = render();
  await options.onText?.(field, source, false, { replace: source }, { decoder: 'ast', step, cursor: gridCursor(source), bytes: Buffer.byteLength(source) });
  return source;
}

export const adapterFor = (dialect: Dialect): AstAdapter => ({
  id: dialect.id, extensions: dialect.extensions, languages: dialect.languages,
  generate: (decisions, state, field, options) => generateProgram(dialect, decisions, state, field, options),
  validate: (source, signal) => dialect.validate(source, signal),
});

export const group = (e: Expr, text: string): string => e.kind === 'binary' || e.kind === 'compare' ? `(${text})` : text;

export const escapeDoubleQuoted = (value: string): string => JSON.stringify(value);

export const BIN: Record<BinOp, string> = { add: '+', sub: '-', mul: '*', div: '/', mod: '%', concat: '+' };
export const CMP: Record<CmpOp, string> = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };

export const hasHole = (e: Expr): boolean => e.kind === 'hole' || (e.kind === 'binary' || e.kind === 'compare' ? hasHole(e.left) || hasHole(e.right)
  : e.kind === 'call' ? e.args.some(hasHole) : e.kind === 'list' ? e.items.some(hasHole) : e.kind === 'index' ? hasHole(e.target) || hasHole(e.index) : false);
