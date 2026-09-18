import { spawn } from 'node:child_process';
import type { Decisions, State } from './decisions.js';
import type { GenerateOptions } from './generation.js';
import { gridCursor } from './grid.js';
import { compactContext, MAX_GRID_REQUEST_BYTES } from './scored-grid.js';
import { buildDecisionContext, PENDING, windowSource } from './decision-context.js';
import { LimitError } from './types.js';
import { choice } from '@typesafe-ai/sdk';

export interface PythonNode { _type: string; [field: string]: unknown }
const node = (_type: string, fields: Record<string, unknown> = {}): PythonNode => ({ _type, ...fields });
const name = (id: string, store = false): PythonNode => node('Name', { id, ctx: node(store ? 'Store' : 'Load') });
const keywords = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '));
const builtins = ['print', 'range', 'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'sum', 'min', 'max', 'abs', 'sorted', 'enumerate', 'zip', 'input', 'open'];
interface Symbol { kind: 'builtin' | 'variable' | 'parameter' | 'function' | 'module'; arity?: number }
interface Scope { names: Map<string, Symbol>; parent?: Scope; function: boolean; loop: boolean }
const symbolTable = (scope: Scope): Record<string, Symbol> => ({ ...(scope.parent ? symbolTable(scope.parent) : Object.fromEntries(builtins.map(id => [id, { kind: 'builtin' }]))), ...Object.fromEntries(scope.names) });
const visible = (scope: Scope): string[] => [...new Set([...scope.names.keys(), ...(scope.parent ? visible(scope.parent) : builtins)])];

function previewTree(value: unknown, field = ''): unknown {
  if (Array.isArray(value)) return value.length ? value.map(item => previewTree(item, field)) : field === 'body' ? [node('Pass')] : [];
  if (!value || typeof value !== 'object') return value;
  const ast = value as PythonNode;
  if (ast._type === 'Hole') return field === 'body' ? node('Expr', { value: name(PENDING) }) : name(PENDING);
  return Object.fromEntries(Object.entries(ast).map(([key, child]) => [key, ast._type === 'Module' && key === 'body' && Array.isArray(child) && !child.length ? [] : previewTree(child, key)]));
}

/** Only the trusted serializer runs here. Generated Python is compiled, never executed. */
const bridge = String.raw`
import ast, json, sys
if sys.version_info < (3, 9):
    raise RuntimeError('Python AST generation requires Python 3.9 or newer')
def decode(value):
    if isinstance(value, list): return [decode(item) for item in value]
    if not isinstance(value, dict): return value
    kind = value.get('_type')
    cls = getattr(ast, kind, None)
    if not isinstance(cls, type) or not issubclass(cls, ast.AST): raise ValueError('Invalid AST node')
    fields = {key: decode(item) for key, item in value.items() if key != '_type'}
    if 'type_params' not in cls._fields and fields.get('type_params') == []: fields.pop('type_params')
    if any(key not in cls._fields for key in fields): raise ValueError('Invalid AST field')
    return cls(**fields)
tree = ast.fix_missing_locations(decode(json.load(sys.stdin)))
compile(tree, '<jev-ast>', 'exec')
source = ast.unparse(tree)
if source: source += '\n'
compile(ast.parse(source), '<jev-source>', 'exec')
print(json.dumps(source))
`;

async function runPythonJson(input: unknown, signal: AbortSignal, maxBytes: number, script: string): Promise<string> {
  signal.throwIfAborted();
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', '-c', script], { env, stdio: ['pipe', 'pipe', 'pipe'], signal, timeout: 10_000 });
    const output: Buffer[] = [];
    let outputBytes = 0, error = '', failed = false;
    const fail = (reason: unknown): void => { if (failed) return; failed = true; child.kill('SIGKILL'); reject(reason); };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes * 6 + 1024) fail(new LimitError('Unparsed Python exceeds the source byte budget.'));
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-8000); });
    child.on('close', code => {
      if (failed) return;
      if (signal.aborted) { reject(signal.reason); return; }
      if (code !== 0) { reject(new Error(`Python AST validation failed: ${error.trim() || `exit ${code}`}`)); return; }
      try {
        const source: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (typeof source !== 'string') throw new Error('Python returned invalid source.');
        if (Buffer.byteLength(source) > maxBytes) throw new LimitError('Unparsed Python exceeds the source byte budget.');
        resolve(source);
      } catch (reason) { reject(reason); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function unparsePython(tree: PythonNode, signal: AbortSignal, maxBytes = 256_000): Promise<string> {
  return runPythonJson(tree, signal, maxBytes, bridge);
}
export async function validatePythonSource(source: string, signal: AbortSignal): Promise<void> {
  await runPythonJson(source, signal, Math.max(1, Buffer.byteLength(source)), "import ast,json,sys; source=json.load(sys.stdin); compile(ast.parse(source),'<jev>','exec'); print(json.dumps(source))");
}

/** Sequential productions are dependent; independent text/tool fields remain parallel. */
export async function generatePythonAst(decisions: Decisions, state: State, field: string, options: GenerateOptions): Promise<string> {
  const task = state.task as { prompt?: string; updates?: string[] } | undefined;
  const objective = [task?.prompt ?? '', ...(task?.updates ?? [])].join('\n');
  const tree = node('Module', { body: [], type_ignores: [] });
  let step = 0;
  const maxDepth = 8;
  const words = objective.match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? [];
  const identifiers = [...new Set([...words.filter(word => /^[a-z_][a-z_0-9]*$/.test(word) && !keywords.has(word)), 'message', 'result', 'value', 'i', 'main', 'add', 'a', 'b', 'guess', 'target', 'attempts', 'randint', 'append', 'read', 'write', 'strip', 'lower'])].slice(0, 180);
  const quoted = [...objective.matchAll(/`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/g)].map(match => match[1] ?? match[2] ?? match[3]!);
  const literals: string[] = [...quoted];
  // Candidates are terminal values derived from the objective, never source templates.
  for (let start = 0; start < words.length; start++) for (let count = 1; count <= 3 && start + count <= words.length; count++) {
    const phrase = words.slice(start, start + count).join(' ');
    const capital = phrase[0]!.toUpperCase() + phrase.slice(1);
    literals.push(phrase, capital, capital + '!');
    if (count > 1) literals.push(words[start]![0]!.toUpperCase() + words[start]!.slice(1) + ', ' + words.slice(start + 1, start + count).join(' ') + '!');
  }
  const strings = [...new Set(literals)].slice(0, 220);
  const numbers = [...new Set([0, 1, 2, 5, 10, ...((objective.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number))])].filter(Number.isFinite).slice(0, 200);
  const context = compactContext(state);

  async function pick(slot: string, scope: Scope, criteria: Record<string, string>, depth = 0): Promise<string> {
    decisions.signal.throwIfAborted();
    if (++step > options.maxSteps) throw new LimitError(`Python AST production budget exhausted (${options.maxSteps}).`);
    const keys = Object.keys(criteria);
    if (!keys.length) throw new Error(`No valid Python AST production for ${slot}.`);
    const preview = await unparsePython(previewTree(tree) as PythonNode, decisions.signal, options.maxBytes);
    const instruction = `Choose the next valid Python AST production for ${slot}. The rendered source marks the slot being filled with ${PENDING}. Satisfy the objective with the smallest sufficient program. Complete the current slot only; do not add unrequested behavior.`;
    const core = { field, phase: 'ast', slot, symbols: visible(scope), symbolTable: symbolTable(scope),
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
    ], parts => Buffer.byteLength(JSON.stringify({ state: assemble(parts), questions: { selection: choice(instruction, criteria) } })), MAX_GRID_REQUEST_BYTES);
    const input = assemble(trimmed.length ? { ...values, trimmed } : values);
    const selected = keys.length === 1 ? keys[0]! : await decisions.choose(input, instruction, criteria);
    await options.onText?.(field, preview, false, { replace: preview }, {
      decoder: 'ast', step, cursor: gridCursor(preview), bytes: Buffer.byteLength(preview), ast: { slot, production: selected, symbols: visible(scope) },
    });
    return selected;
  }

  async function terminal(slot: string, scope: Scope, values: Array<string | number>): Promise<string | number> {
    const criteria: Record<string, string> = Object.fromEntries(values.map((value, index) => [`value_${index}`, JSON.stringify(value)]));
    criteria.custom = 'Compose a different terminal value from valid token choices, staying in AST generation.';
    const selected = await pick(slot, scope, criteria);
    if (selected !== 'custom') return values[Number(selected.slice(6))]!;
    const numeric = slot === 'number';
    const identifierSlot = slot !== 'string' && !numeric;
    const pieces = numeric ? '0123456789.-'.split('') : [...new Set([...words, ...identifiers, ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split(''), ...(identifierSlot ? [] : [' ', ', ', ': ', '!', '?', '.', '\n'])])].slice(0, 240);
    let result = '';
    for (let count = 0; count < 64; count++) {
      const candidates: Record<string, string> = Object.fromEntries(pieces.map((piece, index) => [`piece_${index}`, JSON.stringify(piece)]));
      if (result || slot === 'string') candidates.end = 'This terminal value is complete.';
      const selected = await pick(`${slot}_token:${JSON.stringify(result)}`, scope, candidates);
      if (selected === 'end') return result;
      result += pieces[Number(selected.slice(6))]!;
      if (Buffer.byteLength(result) > Math.min(options.maxBytes, 8000)) throw new LimitError('AST terminal exceeds its byte budget.');
    }
    throw new LimitError('AST terminal token budget exhausted; no grid fallback was used.');
  }

  async function identifier(slot: string, scope: Scope, exclude: string[] = []): Promise<string> {
    const value = String(await terminal(slot, scope, identifiers.filter(value => !exclude.includes(value))));
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(value) || keywords.has(value) || exclude.includes(value)) throw new Error(`Invalid Python identifier: ${value}`);
    return value;
  }

  async function expression(target: PythonNode, scope: Scope, depth: number, slot = 'expression', numberConstraint?: 'positive' | 'nonzero'): Promise<void> {
    const namesForValue = visible(scope).filter(id => !['builtin', 'function'].includes(symbolTable(scope)[id]!.kind));
    const criteria: Record<string, string> = { string: 'A literal string.', number: 'A numeric literal.', boolean: 'True, False or None.' };
    if (namesForValue.length) criteria.name = 'Reference an already defined variable, parameter or module.';
    if (depth < maxDepth) Object.assign(criteria, { call: 'Call a function, such as print, with arguments.', binary: 'Combine two expressions with arithmetic.', compare: 'Compare two expressions.', list: 'A list of expressions.', attribute: 'Read an attribute from a defined object.', subscript: 'Index a defined object.' });
    const production = await pick(slot, scope, criteria, depth);
    if (production === 'string') { Object.assign(target, node('Constant', { value: String(await terminal('string', scope, strings)), kind: null })); }
    else if (production === 'number') {
      const value = Number(await terminal('number', scope, numbers.filter(value => numberConstraint === 'positive' ? value > 0 : numberConstraint === 'nonzero' ? value !== 0 : true)));
      if (!Number.isFinite(value)) throw new Error('Invalid Python number.');
      if ((numberConstraint === 'positive' && value <= 0) || (numberConstraint === 'nonzero' && value === 0)) throw new Error('Range bound violates its numeric constraint.');
      Object.assign(target, node('Constant', { value, kind: null }));
    } else if (production === 'boolean') {
      const value = await pick('singleton', scope, { true: 'True', false: 'False', none: 'None' });
      Object.assign(target, node('Constant', { value: value === 'none' ? null : value === 'true', kind: null }));
    } else if (production === 'name') {
      const names = namesForValue;
      const selected = await pick('reference', scope, Object.fromEntries(names.map((value, index) => [`name_${index}`, value])));
      Object.assign(target, name(names[Number(selected.slice(5))]!));
    } else if (production === 'call') {
      const func = node('Hole');
      const args: PythonNode[] = [];
      Object.assign(target, node('Call', { func, args, keywords: [] }));
      // Direct callees come from the symbol table; members have a defined receiver.
      const names = visible(scope);
      const callees: Record<string, string> = Object.fromEntries(names.map((value, index) => [`name_${index}`, value]));
      callees.member = 'Call an attribute or method of an already defined object or module.';
      const selected = await pick('callee', scope, callees);
      let arity: number | undefined;
      if (selected === 'member') {
        const receiver = await pick('receiver', scope, Object.fromEntries(names.map((value, index) => [`name_${index}`, value])));
        Object.assign(func, node('Attribute', { value: name(names[Number(receiver.slice(5))]!), attr: await identifier('method_name', scope), ctx: node('Load') }));
      } else {
        const id = names[Number(selected.slice(5))]!;
        Object.assign(func, name(id));
        arity = symbolTable(scope)[id]?.arity;
      }
      const counts = arity === undefined ? [0, 1, 2, 3] : [arity];
      const count = Number(await pick('argument_count', scope, Object.fromEntries(counts.map(value => [String(value), `${value} positional arguments.`]))));
      for (let i = 0; i < count; i++) {
        const arg = node('Hole'); args.push(arg);
        const range = func._type === 'Name' && func.id === 'range';
        const explicitRange = /range\s*\(|\b(?:empty|zero iterations|zero times)\b/i.test(objective);
        const constraint = range && i === 2 ? 'nonzero' : range && !explicitRange && count === 1 ? 'positive' : undefined;
        await expression(arg, scope, depth + 1, `argument_${i}`, constraint);
      }
    } else if (production === 'binary' || production === 'compare') {
      const left = node('Hole'), right = node('Hole');
      const operators = production === 'binary' ? { Add: 'addition +', Sub: 'subtraction -', Mult: 'multiplication *', Div: 'division /', FloorDiv: 'integer division //', Mod: 'remainder %', Pow: 'power **' } : { Eq: 'equal ==', NotEq: 'not equal !=', Lt: 'less than <', LtE: 'less or equal <=', Gt: 'greater than >', GtE: 'greater or equal >=', In: 'membership in' };
      const operator = await pick('operator', scope, operators);
      Object.assign(target, production === 'binary' ? node('BinOp', { left, op: node(operator), right }) : node('Compare', { left, ops: [node(operator)], comparators: [right] }));
      await expression(left, scope, depth + 1, 'left'); await expression(right, scope, depth + 1, 'right');
    } else if (production === 'list') {
      const elts: PythonNode[] = [];
      Object.assign(target, node('List', { elts, ctx: node('Load') }));
      const count = Number(await pick('element_count', scope, { '0': 'Empty list.', '1': 'One element.', '2': 'Two elements.', '3': 'Three elements.' }));
      for (let i = 0; i < count; i++) { const value = node('Hole'); elts.push(value); await expression(value, scope, depth + 1, `element_${i}`); }
    } else {
      const value = node('Hole');
      Object.assign(target, production === 'attribute' ? node('Attribute', { value, attr: await identifier('attribute_name', scope), ctx: node('Load') }) : node('Subscript', { value, slice: node('Hole'), ctx: node('Load') }));
      await expression(value, scope, depth + 1, 'object');
      if (production === 'subscript') await expression(target.slice as PythonNode, scope, depth + 1, 'index');
    }
  }

  async function block(body: PythonNode[], scope: Scope, depth: number, slot: string): Promise<void> {
    while (true) {
      const criteria: Record<string, string> = { expr: 'Evaluate an expression, usually a function call such as print.', assign: 'Assign a value to a variable.' };
      criteria.pass = 'An explicit empty statement (pass), for a required empty block.';
      if (body.length || (slot === 'module_body' && options.allowEmpty)) criteria.finish = 'This block satisfies its required behavior; finish it now.';
      if (scope.function) criteria.return = 'Return a value from this function.';
      if (scope.loop) { criteria.break = 'Break from the enclosing loop.'; criteria.continue = 'Continue the enclosing loop.'; }
      if (depth < maxDepth) Object.assign(criteria, { function: 'Define a named function.', if: 'Conditional statement.', for: 'For loop over an iterable.', while: 'While loop.', import: 'Import a Python standard library module.' });
      const statement = node('Hole'); body.push(statement);
      const production = await pick(slot, scope, criteria, depth);
      if (production === 'finish') { body.pop(); return; }
      if (production === 'expr' || production === 'assign' || production === 'return') {
        const value = node('Hole');
        if (production === 'expr') Object.assign(statement, node('Expr', { value }));
        if (production === 'return') Object.assign(statement, node('Return', { value }));
        let id: string | undefined;
        if (production === 'assign') { id = await identifier('assignment_name', scope); Object.assign(statement, node('Assign', { targets: [name(id, true)], value, type_comment: null })); }
        await expression(value, scope, depth + 1);
        if (id) scope.names.set(id, { kind: 'variable' }); // RHS cannot reference a name before assignment.
        if (production === 'return') return;
      } else if (production === 'pass') Object.assign(statement, node('Pass'));
      else if (production === 'break' || production === 'continue') { Object.assign(statement, node(production === 'break' ? 'Break' : 'Continue')); return; }
      else if (production === 'import') {
        const modules = ['math', 'json', 'sys', 'os', 'pathlib', 'random', 'datetime', 'collections', 're', 'itertools'];
        const module = await pick('module', scope, Object.fromEntries(modules.map(value => [value, value])));
        Object.assign(statement, node('Import', { names: [node('alias', { name: module, asname: null })] })); scope.names.set(module, { kind: 'module' });
      } else if (production === 'function') {
        const id = await identifier('function_name', scope);
        const parameters: PythonNode[] = [], nestedBody: PythonNode[] = [];
        Object.assign(statement, node('FunctionDef', { name: id, args: node('arguments', { posonlyargs: [], args: parameters, vararg: null, kwonlyargs: [], kw_defaults: [], kwarg: null, defaults: [] }), body: nestedBody, decorator_list: [], returns: null, type_comment: null, type_params: [] }));
        scope.names.set(id, { kind: 'function' });
        const child: Scope = { names: new Map(), parent: scope, function: true, loop: false };
        const count = Number(await pick('parameter_count', scope, { '0': 'No parameters.', '1': 'One parameter.', '2': 'Two parameters.', '3': 'Three parameters.' }));
        for (let i = 0; i < count; i++) { const parameter = await identifier(`parameter_${i}`, child, [...child.names.keys()]); child.names.set(parameter, { kind: 'parameter' }); parameters.push(node('arg', { arg: parameter, annotation: null, type_comment: null })); }
        scope.names.set(id, { kind: 'function', arity: count });
        await block(nestedBody, child, depth + 1, 'function_body');
      } else {
        const nestedBody: PythonNode[] = [], test = node('Hole');
        if (production === 'for') {
          const id = await identifier('loop_variable', scope);
          Object.assign(statement, node('For', { target: name(id, true), iter: test, body: nestedBody, orelse: [], type_comment: null }));
          await expression(test, scope, depth + 1, 'iterable');
          // A loop may run zero times, so its variable is only guaranteed inside the body.
          await block(nestedBody, { names: new Map([[id, { kind: 'variable' }]]), parent: scope, function: scope.function, loop: true }, depth + 1, 'loop_body');
        } else {
          Object.assign(statement, node(production === 'if' ? 'If' : 'While', { test, body: nestedBody, orelse: [] }));
          await expression(test, scope, depth + 1, 'condition');
          await block(nestedBody, { names: new Map(), parent: scope, function: scope.function, loop: production === 'while' || scope.loop }, depth + 1, production === 'if' ? 'if_body' : 'loop_body');
          if (production === 'if' && await pick('else_branch', scope, { no: 'No else branch is required.', yes: 'Add an else branch.' }) === 'yes') await block(statement.orelse as PythonNode[], { names: new Map(), parent: scope, function: scope.function, loop: scope.loop }, depth + 1, 'else_body');
        }
      }
    }
  }
  await block(tree.body as PythonNode[], { names: new Map(), function: false, loop: false }, 0, 'module_body');
  const source = await unparsePython(tree, decisions.signal, options.maxBytes);
  await options.onText?.(field, source, true, { replace: source }, { decoder: 'ast', step, cursor: gridCursor(source), bytes: Buffer.byteLength(source) });
  return source;
}
