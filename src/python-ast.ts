import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Decisions, State } from './decisions.js';
import type { GenerateOptions } from './generation.js';
import { assemble, assembleProject, cachedPeer, commitRepairedUnit, decompose, decomposeLayout, dropUnitCache, ENTRY, fillUnits, invalidateCachedBodies, isEntry, loadUnitCache, normalizeUnitTask, peersOf, saveUnitCache, unitAttemptPath, unitFromCached, unitToCached, type FailureAttribution, type Layout, type Peer, type Unit, type UnitCacheEntry, type UnitCheck, type UnitRepair } from './python-units.js';
import { RUBRIC, wantsReturn } from './python-search.js';
import { gridCursor } from './grid.js';
import { compactContext, MAX_GRID_REQUEST_BYTES } from './scored-grid.js';
import { astDecisionState, PENDING } from './decision-context.js';
import { attemptScope, type DecisionKind, type DecisionPathEntry, type LineSlot, type RunContext } from './run-context.js';
import { sanitizedEnv } from './env.js';
import { LimitError } from './types.js';
import { identifierCandidates, numberCandidates, objectiveWords, phraseLiterals, quotedLiterals, stringCandidates } from './vocab.js';
import { choice } from '@typesafe-ai/sdk';
import { functionDef, name, node, type Builder, type PythonNode, type Scope, type Symbol, type Vocab } from './python-nodes.js';
export type { PythonNode } from './python-nodes.js';

const keywords = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '));
const builtins = ['print', 'range', 'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'sum', 'min', 'max', 'abs', 'sorted', 'enumerate', 'zip', 'input', 'open'];
const builtinArity: Record<string, number[]> = { print: [0, 1, 2, 3], range: [1, 2, 3], len: [1], str: [0, 1], int: [0, 1], float: [0, 1], list: [0, 1], dict: [0], set: [0, 1], sum: [1, 2], min: [1, 2, 3], max: [1, 2, 3], abs: [1], sorted: [1], enumerate: [1, 2], zip: [1, 2, 3], input: [0, 1], open: [1, 2, 3] };
const maxBlockStatements = 16;
const symbolTable = (scope: Scope): Record<string, Symbol> => ({ ...(scope.parent ? symbolTable(scope.parent) : Object.fromEntries(builtins.map(id => [id, { kind: 'builtin' }]))), ...Object.fromEntries(scope.names) });
const visible = (scope: Scope): string[] => [...new Set([...scope.names.keys(), ...(scope.parent ? visible(scope.parent) : builtins)])];

const statementLists = new Set(['body', 'orelse', 'finalbody']);

export function previewTree(value: unknown, field = ''): unknown {
  if (Array.isArray(value)) return value.length ? value.map(item => previewTree(item, field)) : field === 'body' ? [node('Pass')] : [];
  if (!value || typeof value !== 'object') return value;
  const ast = value as PythonNode;
  if (ast._type === 'Hole') return statementLists.has(field) ? node('Expr', { value: name(PENDING) }) : name(PENDING);
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

async function runPythonJson(input: unknown, signal: AbortSignal, maxBytes: number, script: string, cwd?: string): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', '-c', script], { env: sanitizedEnv(), stdio: ['pipe', 'pipe', 'pipe'], signal, timeout: 10_000, ...(cwd === undefined ? {} : { cwd }) });
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

/** Static only: every file is compiled and every import target is located on disk; nothing is imported or executed. */
const projectBridge = String.raw`
import ast, json, os, sys, importlib.util
root = os.getcwd()
paths = json.load(sys.stdin)
for top in sorted({p.split('/')[0].removesuffix('.py') for p in paths}):
    if importlib.util.find_spec(top) is not None: raise ValueError(f'{top} shadows an installed module')
sys.path.insert(0, root)
def local(parts):
    base = os.path.join(root, *parts)
    if os.path.isfile(base + '.py'): return base + '.py'
    if os.path.isdir(base) and os.path.isfile(os.path.join(base, '__init__.py')): return os.path.join(base, '__init__.py')
    return None
def resolve(name, where):
    parts = name.split('.')
    if local(parts[:1]) is None:
        if importlib.util.find_spec(parts[0]) is None: raise ValueError(f'{where}: cannot resolve import {name}')
        return None
    for i in range(1, len(parts) + 1):
        if local(parts[:i]) is None: raise ValueError(f'{where}: cannot resolve import {name}')
    return local(parts)
def exported(path):
    names = set()
    for stmt in ast.parse(open(path, encoding='utf-8').read()).body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): names.add(stmt.name)
        elif isinstance(stmt, ast.Assign): names.update(t.id for t in stmt.targets if isinstance(t, ast.Name))
        elif isinstance(stmt, (ast.Import, ast.ImportFrom)): names.update((a.asname or a.name).split('.')[0] for a in stmt.names)
    return names
def check(path, tree):
    for stmt in ast.walk(tree):
        if isinstance(stmt, ast.Import):
            for a in stmt.names: resolve(a.name, path)
        elif isinstance(stmt, ast.ImportFrom):
            if stmt.level: raise ValueError(f'{path}: relative imports are not supported')
            target = resolve(stmt.module, path)
            if target is None: continue
            if target.endswith('__init__.py'):
                pkg = os.path.dirname(target)
                for a in stmt.names:
                    if a.name != '*' and a.name not in exported(target) and local(stmt.module.split('.') + [a.name]) is None:
                        raise ValueError(f'{path}: {stmt.module} has no name {a.name}')
            else:
                names = exported(target)
                for a in stmt.names:
                    if a.name != '*' and a.name not in names: raise ValueError(f'{path}: {stmt.module} has no name {a.name}')
for path in paths:
    source = open(os.path.join(root, path), encoding='utf-8').read()
    try: tree = ast.parse(source, path)
    except SyntaxError as err: raise ValueError(f'{path}: {err.msg} (line {err.lineno})')
    compile(tree, path, 'exec')
for path in paths:
    check(path, ast.parse(open(os.path.join(root, path), encoding='utf-8').read(), path))
print(json.dumps('ok'))
`;

export const manifestPath = /^(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z_][A-Za-z0-9_]*\.py$/;

export function parseManifest(text: string): Record<string, string> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('files must be a JSON manifest of path to content.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('files must be a JSON manifest of path to content.');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) throw new Error('files manifest is empty.');
  for (const [path, content] of entries) {
    if (!manifestPath.test(path)) throw new Error(`Invalid manifest path: ${path}`);
    if (typeof content !== 'string') throw new Error(`Manifest content for ${path} must be a string.`);
  }
  return raw as Record<string, string>;
}

export async function validatePythonProject(files: Record<string, string>, signal: AbortSignal, dir?: string): Promise<void> {
  signal.throwIfAborted();
  const paths = Object.keys(files);
  for (const path of paths) if (!manifestPath.test(path)) throw new Error(`Invalid manifest path: ${path}`);
  const root = dir ?? await mkdtemp(join(tmpdir(), 'jev-project-'));
  try {
    for (const path of paths) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, files[path]!, 'utf8');
    }
    await runPythonJson(paths, signal, 16, projectBridge, root);
  } finally {
    if (dir === undefined) await rm(root, { recursive: true, force: true });
  }
}

const checkBridge = String.raw`
import ast, json, sys, builtins
spec = json.load(sys.stdin)
def done(reason, symbol=None):
    print(json.dumps(json.dumps({'reason': reason, 'symbol': symbol} if symbol else {'reason': reason}))); sys.exit(0)
try:
    tree = ast.parse(spec['source'])
    compile(tree, '<candidate>', 'exec')
except Exception:
    done('compile')
fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == spec['name']), None)
if fn is None: done('compile')
defined = set(dir(builtins)) | set(spec['params']) | set(spec['peers']) | {spec['name']}
for n in ast.walk(fn):
    if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store): defined.add(n.id)
    elif isinstance(n, (ast.Import, ast.ImportFrom)): defined.update((a.asname or a.name).split('.')[0] for a in n.names)
    elif isinstance(n, ast.FunctionDef): defined.add(n.name); defined.update(a.arg for a in n.args.args)
    elif isinstance(n, ast.ExceptHandler) and n.name: defined.add(n.name)
for n in ast.walk(fn):
    if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in defined: done('undefined', n.id)
for n in ast.walk(fn):
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in spec['peers'] and (len(n.args) != spec['peers'][n.func.id] or n.keywords): done('arity', n.func.id)
if spec['wantsReturn'] and not any(isinstance(n, ast.Return) and n.value is not None for n in ast.walk(fn)): done('return')
done('ok')
`;

export interface CandidateSpec { name: string; params: string[]; peers: Record<string, number>; wantsReturn: boolean }
export interface CandidateDiagnosis { reason: 'compile' | 'undefined' | 'arity' | 'return'; symbol?: string }
const candidateReasons = new Set<string>(['compile', 'undefined', 'arity', 'return']);

/**
 * Static only: compile, undefined names, peer arity, missing return. Nothing is executed.
 * Returns the first reason plus the offending symbol when the check knows one; undefined when the
 * candidate passes.
 */
export async function diagnoseCandidate(source: string, spec: CandidateSpec, signal: AbortSignal): Promise<CandidateDiagnosis | undefined> {
  const raw = await runPythonJson({ source, ...spec }, signal, 512, checkBridge);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`Python candidate check returned an invalid result: ${raw}`); }
  if (!parsed || typeof parsed !== 'object') throw new Error(`Python candidate check returned an invalid result: ${raw}`);
  const result = parsed as { reason?: unknown; symbol?: unknown };
  if (result.reason === 'ok') return undefined;
  if (typeof result.reason !== 'string' || !candidateReasons.has(result.reason)) throw new Error(`Python candidate check returned an invalid reason: ${raw}`);
  return { reason: result.reason as CandidateDiagnosis['reason'], ...(typeof result.symbol === 'string' ? { symbol: result.symbol } : {}) };
}

/** Static only: compile, undefined names, peer arity, missing return. Nothing is executed. */
export async function checkCandidate(source: string, spec: CandidateSpec, signal: AbortSignal): Promise<string | undefined> {
  return (await diagnoseCandidate(source, spec, signal))?.reason;
}

export interface Shared { field: string; options: GenerateOptions; objective: string; context: State; budget: { step: number }; vocab: Vocab; maxDepth: number }
export interface StepInfo { slot: string; production: string; symbols: string[] }
/** Deterministic replay of a recorded decision path with one forced leaf answer. */
export interface BuilderReplay {
  path: readonly DecisionPathEntry[];
  /** Decision to override; other decisions use their recorded labels. */
  forceId?: number;
  forced?: string;
}
export interface BuilderInput { decisions: Decisions; render: () => Promise<string>; report: (preview: string, info: StepInfo) => Promise<void>; unit?: string; peers?: Peer[]; candidate?: number; repair?: UnitRepair; replay?: BuilderReplay }

const seeds = ['message', 'result', 'value', 'i', 'main', 'add', 'a', 'b', 'guess', 'target', 'attempts', 'randint', 'append', 'read', 'write', 'strip', 'lower'];

export function vocabulary(objective: string): Vocab {
  const words = objectiveWords(objective);
  const identifiers = identifierCandidates(words, keywords, seeds);
  const files = objective.match(/\b[A-Za-z_][A-Za-z_0-9-]*\.[a-z]{1,5}\b/g) ?? [];
  const strings = stringCandidates([...quotedLiterals(objective), ...files, ...phraseLiterals(words)]);
  const purposes: string[] = [];
  for (let start = 0; start < words.length; start++) for (let count = 1; count <= 4 && start + count <= words.length; count++) purposes.push(words.slice(start, start + count).join(' ').toLowerCase());
  return { words, identifiers, strings, numbers: numberCandidates(objective), purposes: [...new Set(purposes)].slice(0, 160) };
}

export function createBuilder(shared: Shared, input: BuilderInput): Builder {
  const { decisions, render, report, unit, peers, candidate, repair, replay } = input;
  const { field, options, objective, context, budget, vocab, maxDepth } = shared;
  const { words, identifiers, strings, numbers } = vocab;
  const runContext = options.context ?? decisions.runContext;
  const pathScope = attemptScope(field, unit, candidate);
  // Retry narrowing: `arity` forbids the offending peer call; `undefined` keeps the offending
  // name out of every reference-shaped pick; `return` forces a return; `compile` changes no
  // criteria and only carries the failed snippet in state.
  const referenceForbidden = new Set<string>(repair?.reason === 'undefined' && repair.symbol !== undefined ? [repair.symbol] : []);
  const calleeForbidden = new Set<string>(repair?.reason === 'arity' && repair.symbol !== undefined ? [repair.symbol] : []);
  // A regenerated attempt starts a fresh decision path; its previous entries are invalidated.
  // A replay consumes the recorded path instead, so its entries must stay valid.
  if (replay === undefined) runContext.beginAttempt(pathScope);
  let replayIndex = 0;

  async function pick(slot: string, scope: Scope, criteria: Record<string, string>, depth = 0, kind: DecisionKind = 'structural'): Promise<string> {
    decisions.signal.throwIfAborted();
    if (++budget.step > options.maxSteps) throw new LimitError(`Python AST production budget exhausted (${options.maxSteps}).`);
    const keys = Object.keys(criteria);
    if (!keys.length) throw new Error(`No valid Python AST production for ${slot}.`);
    if (replay !== undefined) {
      // Deterministic replay: recorded labels answer the question; a single-label production is
      // host-derived in both modes and never consumes a path entry. No provider request, no render.
      if (keys.length === 1) return keys[0]!;
      const entry = replay.path[replayIndex];
      if (entry === undefined || entry.questionKey !== slot) throw new Error(`Replay path does not match the ${slot} decision.`);
      replayIndex++;
      const selected = entry.decisionId === replay.forceId && replay.forced !== undefined ? replay.forced : entry.chosen;
      if (!Object.hasOwn(criteria, selected)) throw new Error(`Replay answer ${selected} is not a valid production for ${slot}.`);
      return selected;
    }
    const preview = await render();
    const instruction = `Choose the next valid Python AST production for ${slot}. The rendered source marks the slot being filled with ${PENDING}. Satisfy the objective with the smallest sufficient program. Complete the current slot only; do not add unrequested behavior.`;
    const symbols = visible(scope);
    const questions = { selection: choice(instruction, criteria) };
    const core = { field, phase: 'ast', slot, ...(unit === undefined ? {} : { unit }), ...(candidate === undefined ? {} : { candidate }), ...(peers === undefined || !peers.length ? {} : { peers: peers.map(peer => ({ ...peer })) }), symbols, symbolTable: symbolTable(scope),
      ...(repair === undefined ? {} : { repair: { reason: repair.reason, ...(repair.symbol === undefined ? {} : { symbol: repair.symbol }), ...(repair.snippet === undefined ? {} : { snippet: repair.snippet }) } }),
      constraints: { depth, maxDepth, inFunction: scope.function, inLoop: scope.loop, remainingSteps: options.maxSteps - budget.step } };
    const state = astDecisionState({ objective, context, preview, core, questions, cap: MAX_GRID_REQUEST_BYTES });
    const selected = keys.length === 1 ? keys[0]!
      : (await decisions.chooseWithAlternatives(state, instruction, criteria, { scope: pathScope, questionKey: slot, kind, context: runContext, answers: criteria })).choice;
    await report(preview, { slot, production: selected, symbols });
    return selected;
  }

  async function terminal(slot: string, scope: Scope, values: Array<string | number>): Promise<string | number> {
    const criteria: Record<string, string> = Object.fromEntries(values.map((value, index) => [`value_${index}`, JSON.stringify(value)]));
    if (slot === 'string') criteria.custom = 'Compose a different terminal value from valid token choices, staying in AST generation.';
    const selected = await pick(slot, scope, criteria, 0, 'leaf');
    if (selected !== 'custom') return values[Number(selected.slice(6))]!;
    const pieces = [...new Set([...words, ...identifiers, ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split(''), ' ', ', ', ': ', '!', '?', '.', '\n'])].slice(0, 240);
    let result = '', last = '', repeats = 0;
    for (let count = 0; count < 32; count++) {
      const candidates: Record<string, string> = Object.fromEntries(pieces.map((piece, index) => [`piece_${index}`, JSON.stringify(piece)]));
      if (result || slot === 'string') candidates.end = 'This terminal value is complete.';
      const selected = await pick(`${slot}_token:${JSON.stringify(result)}`, scope, candidates, 0, 'leaf');
      if (selected === 'end') return result;
      const piece = pieces[Number(selected.slice(6))]!;
      repeats = piece === last ? repeats + 1 : 1;
      last = piece;
      result += piece;
      if (Buffer.byteLength(result) > Math.min(options.maxBytes, 8000)) throw new LimitError('AST terminal exceeds its byte budget.');
      if (repeats >= 3) return result;
    }
    throw new LimitError('AST terminal token budget exhausted; no grid fallback was used.');
  }

  async function identifier(slot: string, scope: Scope, exclude: string[] = []): Promise<string> {
    const value = String(await terminal(slot, scope, identifiers.filter(value => !exclude.includes(value) && !referenceForbidden.has(value))));
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(value) || keywords.has(value) || exclude.includes(value)) throw new Error(`Invalid Python identifier: ${value}`);
    return value;
  }

  async function expression(target: PythonNode, scope: Scope, depth: number, slot = 'expression', numberConstraint?: 'positive' | 'nonzero', calls = 0): Promise<void> {
    const table = symbolTable(scope);
    const namesForValue = visible(scope).filter(id => !['builtin', 'function'].includes(table[id]!.kind) && !referenceForbidden.has(id));
    // Direct callees come from the symbol table; members have a defined receiver.
    const calleeNames = visible(scope).filter(id => !calleeForbidden.has(id) && !referenceForbidden.has(id));
    const receiverNames = visible(scope).filter(id => !referenceForbidden.has(id));
    const callees: Record<string, string> = Object.fromEntries(calleeNames.map((value, index) => [`name_${index}`, value]));
    if (receiverNames.length) callees.member = 'Call an attribute or method of an already defined object or module.';
    const criteria: Record<string, string> = { string: 'A literal string.', number: 'A numeric literal.', boolean: 'True, False or None.' };
    if (namesForValue.length) criteria.name = 'Reference an already defined variable, parameter or module.';
    if (depth < maxDepth) Object.assign(criteria, { binary: 'Combine two expressions with arithmetic.', compare: 'Compare two expressions.', attribute: 'Read an attribute from a defined object.', subscript: 'Index a defined object.' });
    if (depth < maxDepth && calls < 2 && Object.keys(callees).length) criteria.call = 'Call a function, such as print, with arguments.';
    if (depth < maxDepth && !slot.startsWith('element_') && !slot.startsWith('argument_')) criteria.list = 'A list of expressions.';
    const production = await pick(slot, scope, criteria, depth);
    if (production === 'string') { Object.assign(target, node('Constant', { value: String(await terminal('string', scope, strings)), kind: null })); }
    else if (production === 'number') {
      const value = Number(await terminal('number', scope, numbers.filter(value => numberConstraint === 'positive' ? value > 0 : numberConstraint === 'nonzero' ? value !== 0 : true)));
      if (!Number.isFinite(value)) throw new Error('Invalid Python number.');
      if ((numberConstraint === 'positive' && value <= 0) || (numberConstraint === 'nonzero' && value === 0)) throw new Error('Range bound violates its numeric constraint.');
      Object.assign(target, node('Constant', { value, kind: null }));
    } else if (production === 'boolean') {
      const value = await pick('singleton', scope, { true: 'True', false: 'False', none: 'None' }, 0, 'leaf');
      Object.assign(target, node('Constant', { value: value === 'none' ? null : value === 'true', kind: null }));
    } else if (production === 'name') {
      const names = namesForValue;
      const selected = await pick('reference', scope, Object.fromEntries(names.map((value, index) => [`name_${index}`, value])), 0, 'leaf');
      Object.assign(target, name(names[Number(selected.slice(5))]!));
    } else if (production === 'call') {
      const func = node('Hole');
      const args: PythonNode[] = [];
      Object.assign(target, node('Call', { func, args, keywords: [] }));
      const selected = await pick('callee', scope, callees);
      let arity: number | undefined, counts = [0, 1, 2, 3];
      if (selected === 'member') {
        const receiver = await pick('receiver', scope, Object.fromEntries(receiverNames.map((value, index) => [`name_${index}`, value])), 0, 'leaf');
        Object.assign(func, node('Attribute', { value: name(receiverNames[Number(receiver.slice(5))]!), attr: await identifier('method_name', scope), ctx: node('Load') }));
      } else {
        const id = calleeNames[Number(selected.slice(5))]!;
        Object.assign(func, name(id));
        const symbol = table[id];
        arity = symbol?.arity;
        if (arity !== undefined) counts = [arity];
        else if (symbol?.kind === 'builtin' && builtinArity[id]) counts = builtinArity[id]!;
      }
      const count = Number(await pick('argument_count', scope, Object.fromEntries(counts.map(value => [String(value), `${value} positional arguments.`]))));
      for (let i = 0; i < count; i++) {
        const arg = node('Hole'); args.push(arg);
        const range = func._type === 'Name' && func.id === 'range';
        const explicitRange = /range\s*\(|\b(?:empty|zero iterations|zero times)\b/i.test(objective);
        const constraint = range && i === 2 ? 'nonzero' : range && !explicitRange && count === 1 ? 'positive' : undefined;
        await expression(arg, scope, depth + 1, `argument_${i}`, constraint, calls + 1);
      }
    } else if (production === 'binary' || production === 'compare') {
      const left = node('Hole'), right = node('Hole');
      const operators = production === 'binary' ? { Add: 'addition +', Sub: 'subtraction -', Mult: 'multiplication *', Div: 'division /', FloorDiv: 'integer division //', Mod: 'remainder %', Pow: 'power **' } : { Eq: 'equal ==', NotEq: 'not equal !=', Lt: 'less than <', LtE: 'less or equal <=', Gt: 'greater than >', GtE: 'greater or equal >=', In: 'membership in' };
      const operator = await pick('operator', scope, operators);
      Object.assign(target, production === 'binary' ? node('BinOp', { left, op: node(operator), right }) : node('Compare', { left, ops: [node(operator)], comparators: [right] }));
      await expression(left, scope, depth + 1, 'left', undefined, calls); await expression(right, scope, depth + 1, 'right', undefined, calls);
    } else if (production === 'list') {
      const elts: PythonNode[] = [];
      Object.assign(target, node('List', { elts, ctx: node('Load') }));
      const count = Number(await pick('element_count', scope, { '0': 'Empty list.', '1': 'One element.', '2': 'Two elements.', '3': 'Three elements.' }));
      for (let i = 0; i < count; i++) { const value = node('Hole'); elts.push(value); await expression(value, scope, depth + 1, `element_${i}`, undefined, calls); }
    } else {
      const value = node('Hole');
      Object.assign(target, production === 'attribute' ? node('Attribute', { value, attr: await identifier('attribute_name', scope), ctx: node('Load') }) : node('Subscript', { value, slice: node('Hole'), ctx: node('Load') }));
      await expression(value, scope, depth + 1, 'object');
      if (production === 'subscript') await expression(target.slice as PythonNode, scope, depth + 1, 'index');
    }
  }

  async function block(body: PythonNode[], scope: Scope, depth: number, slot: string): Promise<void> {
    let dups = 0;
    while (body.length < maxBlockStatements) {
      const criteria: Record<string, string> = { expr: 'Evaluate an expression, usually a function call such as print.', assign: 'Assign a value to a variable.' };
      if (!body.length) criteria.pass = 'An explicit empty statement (pass), for a required empty block.';
      if (body.length || (slot === 'module_body' && options.allowEmpty)) criteria.finish = 'This block satisfies its required behavior; finish it now.';
      if (scope.function) criteria.return = 'Return a value from this function.';
      if (scope.loop) { criteria.break = 'Break from the enclosing loop.'; criteria.continue = 'Continue the enclosing loop.'; }
      if (depth < maxDepth) Object.assign(criteria, { function: 'Define a named function.', if: 'Conditional statement.', for: 'For loop over an iterable.', while: 'While loop.', import: 'Import a Python standard library module.' });
      // A `return` retry forces the first statement of the unit body to return a value.
      const forcedReturn = repair?.reason === 'return' && scope.function && slot === 'function_body' && !body.length;
      const statement = node('Hole'); body.push(statement);
      const production = await pick(slot, scope, forcedReturn ? { return: criteria.return ?? 'Return a value from this function.' } : criteria, depth);
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
        Object.assign(statement, functionDef(id, parameters, nestedBody));
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
      const at = body.length - 1;
      if (at > 0 && JSON.stringify(body[at]) === JSON.stringify(body[at - 1])) {
        body.pop();
        if (++dups >= 2) return;
      }
    }
  }
  return { pick, terminal, identifier, expression, block };
}

/** Unit-cache write target: the concrete path when known, else the generation field. */
export function unitCacheTarget(state: State, field: string): string {
  const path = (state.argumentsSoFar as Record<string, unknown> | undefined)?.path;
  return typeof path === 'string' && path ? path : field;
}

/** Runtime-repair outcome, readable by the caller that requested the repair. */
export interface RepairOutcome {
  kind: 'unit-replay' | 'candidate-reuse' | 'module-substitution' | 'unit-regeneration' | 'module-regeneration' | 'none';
  decisionId?: number;
  forced?: string;
  notes: string[];
}

export interface PythonRepairResult { files: Record<string, string>; outcome: RepairOutcome }

interface RepairExecution { attribution: FailureAttribution; outcome: RepairOutcome }

const decompositionSlot = (slot: string): boolean =>
  slot === 'unit_count' || slot === 'package_name' || slot === 'module_count' || /^module_\d+_name$/.test(slot) || /^unit_\d+_/.test(slot);

const moduleNameOf = (layout: Layout, path: string): string | undefined => {
  if (path === `${ENTRY}.py`) return ENTRY;
  const prefix = `${layout.pkg}/`;
  return path.startsWith(prefix) ? `${layout.pkg}.${path.slice(prefix.length).replace(/\.py$/, '')}` : undefined;
};

/**
 * Rebuild one file's line-to-slot map after assembly: a unit definition span (its `def` line plus
 * every indented or blank line that follows) maps to that unit; every other line maps to the module
 * block. The map is keyed by the written path so tracebacks resolve back to decisions.
 */
function recordFileLines(context: RunContext, key: string, target: string, field: string, source: string, fileUnits: readonly Unit[]): void {
  const lines = source.split('\n');
  const spans: Array<{ unit: string; start: number; end: number }> = [];
  for (const unit of fileUnits) {
    const at = lines.findIndex(line => line.startsWith(`def ${unit.name}(`));
    if (at < 0) continue;
    let end = at + 1;
    while (end < lines.length && (lines[end]!.trim() === '' || /^\s/.test(lines[end]!))) end++;
    spans.push({ unit: unit.name, start: at + 1, end });
  }
  const map = new Map<number, LineSlot>();
  for (let line = 1; line <= lines.length; line++) {
    const span = spans.find(candidate => line >= candidate.start && line <= candidate.end);
    map.set(line, span === undefined
      ? { slot: 'module_body', scope: attemptScope(field), target, field }
      : { slot: 'function_body', unit: span.unit, scope: attemptScope(field, span.unit), target, field });
  }
  context.recordLineMap(key, map);
  context.recordSource(key, source);
}

/** Decomposition first, then unit bodies concurrently, then the main block; zero units is the plain single-scope path. */
async function generate(decisions: Decisions, state: State, field: string, options: GenerateOptions, project: boolean, repair?: RepairExecution): Promise<string> {
  const task = state.task as { prompt?: string; updates?: string[] } | undefined;
  const objective = [task?.prompt ?? '', ...(task?.updates ?? [])].join('\n');
  const shared: Shared = { field, options, objective, context: compactContext(state), budget: { step: 0 }, vocab: vocabulary(objective), maxDepth: 8 };
  const tree = node('Module', { body: [], type_ignores: [] });
  const previewOf = (root: PythonNode): Promise<string> => unparsePython(previewTree(root) as PythonNode, decisions.signal, options.maxBytes);
  const emit = async (preview: string, info: StepInfo, unit?: string): Promise<void> => options.onText?.(field, preview, false, { replace: preview }, {
    decoder: 'ast', step: shared.budget.step, cursor: gridCursor(preview), bytes: Buffer.byteLength(preview), ast: { ...info, ...(unit === undefined ? {} : { unit }) },
  });
  const rootScope: Scope = { names: new Map(), function: false, loop: false };
  const peers: Peer[] = [];
  const runContext = options.context ?? decisions.runContext;
  const target = unitCacheTarget(state, field);
  const taskText = normalizeUnitTask(objective);
  runContext.recordGenerationTask(target, taskText, project);
  const attribution = repair?.attribution;
  // Repair trusts the cached entry directly: the failure names the exact generation being repaired.
  const cached = attribution === undefined ? loadUnitCache(runContext, target, taskText) : runContext.units.get(target) as UnitCacheEntry | undefined;
  // A cache-less repair is only possible for a single file whose whole program is module statements.
  if (attribution !== undefined && cached === undefined && project) throw new Error(`No validated unit tree for ${target}; runtime repair is unavailable.`);
  const repairWithoutTree = attribution !== undefined && cached === undefined;
  const makeRoot = (replay?: BuilderReplay): Builder => createBuilder(shared, {
    decisions, peers, ...(replay === undefined ? {} : { replay }), render: () => previewOf(tree), report: (preview, info) => emit(preview, info),
  });
  let layout: Layout | undefined;
  let units: Unit[];
  let pending: Unit[];
  let reused = false;
  let root: Builder | undefined;
  if (cached !== undefined && (project ? cached.layout !== undefined : cached.layout === undefined)) {
    // Within-run reuse: restore the validated unit tree, then revalidate each unit before trusting it.
    reused = true;
    layout = cached.layout;
    peers.push(...cached.units.map(cachedPeer));
    units = [];
    pending = [];
    for (const item of cached.units) {
      const unit = unitFromCached(item);
      units.push(unit);
      if (item.body === undefined) pending.push(unit);
    }
    // A repair replays the recorded module path instead of invalidating it with a fresh attempt.
    if (attribution === undefined) root = makeRoot();
  } else if (repairWithoutTree) {
    // Zero-unit single file: no cache entry exists, and the recorded module path is the whole program.
    units = [];
    pending = [];
  } else {
    if (cached !== undefined) dropUnitCache(runContext, target);
    root = makeRoot();
    layout = project ? await decomposeLayout(root, rootScope) : undefined;
    units = await decompose(root, rootScope, shared.vocab, peers, layout);
    pending = units;
  }
  let repairedUnit: Unit | undefined;
  if (units.length) {
    for (const unit of units) rootScope.names.set(unit.name, { kind: 'function', arity: unit.arity });
    (tree.body as PythonNode[]).push(...units.map(unit => unit.def));
    const assembled = (): Promise<string> => previewOf(node('Module', { body: [...(tree.body as PythonNode[]), node('Hole')], type_ignores: [] }));
    const parentFor = (unit: Unit): Scope => isEntry(unit) ? rootScope
      : { names: new Map(units.filter(u => !isEntry(u)).map(u => [u.name, { kind: 'function' as const, arity: u.arity }])), function: false, loop: false };
    const width = options.searchWidth ?? 1;
    const defOf = (unit: Unit, body?: PythonNode[]): PythonNode => body === undefined ? unit.def : functionDef(unit.name, unit.params.map(p => node('arg', { arg: p, annotation: null, type_comment: null })), body);
    const specOf = (unit: Unit): CandidateSpec => ({ name: unit.name, params: unit.params, peers: Object.fromEntries(peersOf(unit, peers).filter(p => p.name !== unit.name).map(p => [p.name, p.arity])), wantsReturn: wantsReturn(unit.purpose) });
    const unitCheck: UnitCheck = {
      render: (unit, body) => unparsePython(node('Module', { body: [defOf(unit, body)], type_ignores: [] }), decisions.signal, options.maxBytes),
      check: async (unit, source) => {
        const diagnosis = await diagnoseCandidate(source, specOf(unit), decisions.signal);
        return diagnosis === undefined ? undefined : { reason: diagnosis.reason, ...(diagnosis.symbol === undefined ? {} : { symbol: diagnosis.symbol }) };
      },
    };
    const scopeFor = (unit: Unit): Scope => ({ names: new Map(unit.params.map(p => [p, { kind: 'parameter' as const }])), parent: parentFor(unit), function: true, loop: false });
    const validated = new Set<string>();
    if (reused) {
      // A cached unit that fails its check is regenerated in this attempt instead of being reused.
      for (const unit of units) {
        if (pending.includes(unit)) continue;
        const source = await unitCheck.render(unit, unit.body);
        if ((await unitCheck.check(unit, source)) === undefined) validated.add(unit.name);
        else { unit.body.length = 0; pending.push(unit); }
      }
    }
    // Repair for a unit-body failure: replay the recorded leaf alternatives (or reuse a retained
    // search candidate) before falling back to regenerating this one unit.
    const replayUnitRepair = async (unit: Unit): Promise<{ kind: 'replay'; body: PythonNode[]; decisionId: number; forced: string } | { kind: 'candidate'; body: PythonNode[] } | undefined> => {
      const attempt = unitAttemptPath(runContext, field, unit.name, attribution?.scope);
      const path = attempt.entries;
      const failingEntry = attribution?.decisionId === undefined ? undefined : path.find(entry => entry.decisionId === attribution.decisionId);
      // Leaf-only contract: a structural failure never replays; it regenerates instead.
      if (attribution?.decisionId !== undefined && failingEntry?.kind === 'leaf') {
        for (const label of attribution.forced) {
          const body: PythonNode[] = [];
          try {
            await createBuilder(shared, {
              decisions, unit: unit.name, peers: peersOf(unit, peers), replay: { path, forceId: attribution.decisionId, forced: label },
              render: () => previewOf(node('Module', { body: [defOf(unit, body)], type_ignores: [] })), report: async () => {},
            }).block(body, scopeFor(unit), 1, 'function_body');
          } catch { continue; }
          try {
            const source = await unitCheck.render(unit, body);
            if ((await unitCheck.check(unit, source)) === undefined) return { kind: 'replay', body, decisionId: attribution.decisionId, forced: label };
          } catch { continue; }
        }
      }
      // Retained validated search candidates are repair candidates; revalidate before reuse.
      for (const candidate of runContext.candidatesFor(target, unit.name)) {
        const body = structuredClone(candidate) as PythonNode[];
        try {
          const source = await unitCheck.render(unit, body);
          if ((await unitCheck.check(unit, source)) === undefined) return { kind: 'candidate', body };
        } catch { continue; }
      }
      return undefined;
    };
    if (attribution?.unit !== undefined) {
      const unit = units.find(candidate => candidate.name === attribution.unit);
      if (unit === undefined) repair?.outcome.notes.push(`the failing unit ${attribution.unit} is not in the cached tree`);
      else {
        const attempt = await replayUnitRepair(unit);
        if (attempt !== undefined) {
          unit.body.splice(0, unit.body.length, ...attempt.body);
          validated.add(unit.name);
          pending = pending.filter(candidate => candidate !== unit);
          if (attempt.kind === 'replay') {
            repairedUnit = unit;
            if (repair) { repair.outcome.kind = 'unit-replay'; repair.outcome.decisionId = attempt.decisionId; repair.outcome.forced = attempt.forced; }
          } else if (repair) { repair.outcome.kind = 'candidate-reuse'; repair.outcome.notes.push(`reused a retained search candidate for ${unit.name}`); }
        } else {
          // Terminal fallback: regenerate the narrowest unit (this one), cache invalidated.
          invalidateCachedBodies(runContext, target, [unit.name]);
          unit.body.length = 0;
          if (!pending.includes(unit)) pending.push(unit);
          if (repair) { repair.outcome.kind = 'unit-regeneration'; repair.outcome.notes.push(`no replay alternative for ${unit.name}; the unit is regenerated`); }
        }
      }
    }
    try {
      await fillUnits(pending, decisions, (unit, fork, candidate, body, repair) => createBuilder(shared, {
        decisions: fork, unit: unit.name, peers: peersOf(unit, peers), ...(candidate === undefined ? {} : { candidate }), ...(repair === undefined ? {} : { repair }),
        render: () => previewOf(node('Module', { body: [defOf(unit, body)], type_ignores: [] })),
        report: options.onText ? async (_preview, info) => emit(await assembled(), info, unit.name) : async () => {},
      }), parentFor, unitCheck, width > 1 ? {
        width,
        render: (unit, body) => unparsePython(node('Module', { body: [defOf(unit, body)], type_ignores: [] }), decisions.signal, options.maxBytes),
        check: (unit, source) => checkCandidate(source, specOf(unit), decisions.signal),
        score: async (unit, d, source, candidate) => (await d.score({
          task: { prompt: objective },
          generation: { field, phase: 'search', slot: 'candidate_score', unit: unit.name, candidate, spec: { name: unit.name, arity: unit.arity, purpose: unit.purpose, params: unit.params }, peers: peersOf(unit, peers).map(p => ({ ...p })), candidateSource: source },
        }, `Rate how well this candidate body for ${unit.name} fulfils its purpose: ${unit.purpose}. Judge correctness for the objective and minimality; unrequested behavior lowers the level.`, RUBRIC)).expected,
        report: async (unit, c) => {
          // Validated-but-dropped candidates are retained as repair candidates and journaled below.
          if (c.reason === undefined && !c.kept) runContext.retainCandidates(target, unit.name, [structuredClone(c.body)]);
          options.onText?.(field, c.source, false, { replace: c.source }, {
            decoder: 'search', step: shared.budget.step, cursor: gridCursor(c.source), bytes: Buffer.byteLength(c.source),
            ast: { slot: 'candidate', production: c.kept ? 'kept' : 'dropped', symbols: [], unit: unit.name, candidate: c.index, kept: c.kept, ...(c.reason === undefined ? {} : { reason: c.reason }) },
          });
        },
      } : undefined, unit => runContext.invalidateUnitAttempts(field, unit.name), unit => validated.add(unit.name));
    } finally {
      // A failed write keeps every unit that validated before the failure; only the rest regenerate.
      saveUnitCache(runContext, target, { task: taskText, ...(layout === undefined ? {} : { layout: structuredClone(layout) }), units: units.map(unit => unitToCached(unit, validated.has(unit.name))) });
    }
  }
  // Module block: normal generation, or for a repair the recorded module path replayed with the
  // failing leaf substituted (a unit-scope failure replays the module path unchanged, no requests).
  const replayModuleBlock = async (): Promise<void> => {
    const modulePath = runContext.pathFor(attemptScope(field)).filter(entry => !decompositionSlot(entry.questionKey));
    const failingEntry = attribution?.decisionId === undefined ? undefined : modulePath.find(entry => entry.decisionId === attribution.decisionId);
    // Leaf-only contract: only a leaf decision can be substituted, and a module-scope failure
    // without a usable forced alternative cannot be fixed by replaying the module path unchanged.
    const moduleRepair = attribution !== undefined && attribution.unit === undefined;
    const forced = moduleRepair && failingEntry?.kind === 'leaf' ? attribution.forced : [];
    const decisionId = attribution?.decisionId;
    if (modulePath.length && (!moduleRepair || forced.length > 0)) {
      for (const label of (forced.length ? forced : [undefined])) {
        const snapshot = [...(tree.body as PythonNode[])];
        try {
          const builder = makeRoot({ path: modulePath, ...(label === undefined || decisionId === undefined ? {} : { forceId: decisionId, forced: label }) });
          await builder.block(tree.body as PythonNode[], rootScope, 0, 'module_body');
          if (repair !== undefined && label !== undefined && decisionId !== undefined) {
            repair.outcome.kind = 'module-substitution';
            repair.outcome.decisionId = decisionId;
            repair.outcome.forced = label;
          }
          return;
        } catch {
          (tree.body as PythonNode[]).length = 0;
          (tree.body as PythonNode[]).push(...snapshot);
        }
      }
    }
    // No usable recorded path, or every forced alternative mismatched: regenerate the module block.
    runContext.invalidateScope(attemptScope(field));
    await makeRoot().block(tree.body as PythonNode[], rootScope, 0, 'module_body');
    if (repair !== undefined && moduleRepair && repair.outcome.kind === 'none') {
      repair.outcome.kind = 'module-regeneration';
      repair.outcome.notes.push('module replay was unavailable; the module block was regenerated');
    }
  };
  const commitRepair = (): void => {
    if (repair === undefined) return;
    if (repairedUnit !== undefined) commitRepairedUnit(runContext, target, repairedUnit, units);
    if (repair.outcome.decisionId !== undefined && repair.outcome.forced !== undefined) runContext.consumeAlternative(repair.outcome.decisionId, repair.outcome.forced);
  };
  if (attribution !== undefined) await replayModuleBlock();
  else await root!.block(tree.body as PythonNode[], rootScope, 0, 'module_body');
  if (layout) {
    const files = assembleProject(tree, units, layout);
    const manifest: Record<string, string> = {};
    for (const [path, module] of Object.entries(files)) manifest[path] = (module.body as PythonNode[]).length ? await unparsePython(module, decisions.signal, options.maxBytes) : '';
    const text = JSON.stringify(manifest);
    if (Buffer.byteLength(text) > options.maxBytes) throw new LimitError('Python project exceeds its byte budget.');
    if (reused || repair !== undefined) {
      // Reused units skip per-attempt checks, so revalidate the assembled project before returning it.
      try { await validatePythonProject(manifest, decisions.signal); }
      catch (error) { invalidateCachedBodies(runContext, target); throw error; }
    }
    for (const [path, source] of Object.entries(manifest)) recordFileLines(runContext, path, target, field, source, units.filter(unit => unit.module === moduleNameOf(layout!, path)));
    commitRepair();
    await options.onText?.(field, text, true, { replace: text }, { decoder: 'ast', step: shared.budget.step, cursor: gridCursor(text), bytes: Buffer.byteLength(text) });
    return text;
  }
  if (units.length) assemble(tree, units);
  const source = await unparsePython(tree, decisions.signal, options.maxBytes);
  if (reused || repair !== undefined) {
    // Reused units skip per-attempt checks, so revalidate the assembled source before returning it.
    try { await validatePythonSource(source, decisions.signal); }
    catch (error) { invalidateCachedBodies(runContext, target); throw error; }
  }
  recordFileLines(runContext, target, target, field, source, units);
  commitRepair();
  await options.onText?.(field, source, true, { replace: source }, { decoder: 'ast', step: shared.budget.step, cursor: gridCursor(source), bytes: Buffer.byteLength(source) });
  return source;
}

/**
 * Rebuild the file(s) for one runtime failure: unit-body failures replay the recorded leaf
 * alternatives (or a retained search candidate) and regenerate only the failing unit otherwise;
 * module-slot failures replay the module path with the failing leaf substituted. Returns undefined
 * when there is no cached tree to repair from. Non-Python runtime repair is out of scope.
 */
export async function repairPythonFailure(decisions: Decisions, context: RunContext, attribution: FailureAttribution, options: GenerateOptions): Promise<PythonRepairResult | undefined> {
  const entry = context.units.get(attribution.target) as UnitCacheEntry | undefined;
  const recorded = context.generationTaskFor(attribution.target);
  const task = entry?.task ?? recorded?.task;
  if (task === undefined) return undefined;
  const project = entry?.layout !== undefined || (recorded?.project ?? false);
  if (entry === undefined && project) return undefined;
  const state: State = {
    task: { prompt: task, updates: [], turn: 1 },
    ...(attribution.target === attribution.field ? {} : { argumentsSoFar: { path: attribution.target } }),
  };
  const outcome: RepairOutcome = { kind: 'none', notes: [] };
  const text = await generate(decisions, state, attribution.field, options.context === undefined ? { ...options, context } : options, project, { attribution, outcome });
  const files = project ? JSON.parse(text) as Record<string, string> : { [attribution.path]: text };
  return { files, outcome };
}

export const generatePythonAst = (decisions: Decisions, state: State, field: string, options: GenerateOptions): Promise<string> => generate(decisions, state, field, options, false);
/** Returns a JSON manifest of path to source for a package plus entry script. */
export const generatePythonProject = (decisions: Decisions, state: State, field: string, options: GenerateOptions): Promise<string> => generate(decisions, state, field, options, true);
