/**
 * Curated Python call signatures: the value types the Python builder narrows on, the member tables
 * for every module the import production offers, and the builtin signatures the call path consults.
 *
 * Python-local by design: importing `src/lang/core.ts` here would create an import cycle, so `fits`
 * mirrors that module's narrowing helper instead. Unifying the two helpers is follow-up work.
 */

/**
 * Python value types the builder narrows on. Mirrors `ValueType` in `src/lang/core.ts`, plus `none`
 * for Python's `None` (a call whose result is `None` cannot be used where a value is expected).
 */
export type PythonType = 'string' | 'number' | 'bool' | 'list' | 'none' | 'unknown';

/** A curated call signature: accepted positional counts, parameter types, and the common result type. */
export interface Callable {
  /** Accepted positional-argument counts; a single entry is host-derived and asks no count question. */
  arity: number[];
  /** Expected type per positional argument; missing entries accept anything. */
  params?: PythonType[];
  /** Common result type of a call; a missing or `unknown` result never narrows a candidate away. */
  returns?: PythonType;
}

/** Builtin callables the builder offers; ids and arities match the previous inline `builtinArity` table. */
export const BUILTINS: Record<string, Callable> = {
  print: { arity: [0, 1, 2, 3], returns: 'none' },
  range: { arity: [1, 2, 3], params: ['number', 'number', 'number'], returns: 'list' },
  len: { arity: [1], returns: 'number' },
  str: { arity: [0, 1], returns: 'string' },
  int: { arity: [0, 1], returns: 'number' },
  float: { arity: [0, 1], returns: 'number' },
  list: { arity: [0, 1], returns: 'list' },
  dict: { arity: [0], returns: 'unknown' },
  set: { arity: [0, 1], returns: 'unknown' },
  sum: { arity: [1, 2], params: ['list'], returns: 'number' },
  min: { arity: [1, 2, 3], returns: 'number' },
  max: { arity: [1, 2, 3], returns: 'number' },
  abs: { arity: [1], params: ['number'], returns: 'number' },
  sorted: { arity: [1], params: ['list'], returns: 'list' },
  enumerate: { arity: [1, 2], returns: 'unknown' },
  zip: { arity: [1, 2, 3], returns: 'unknown' },
  input: { arity: [0, 1], params: ['string'], returns: 'string' },
  open: { arity: [1, 2, 3], params: ['string', 'string'], returns: 'unknown' },
};

/**
 * Member tables for the modules the import production offers (plus `time`). Only the listed members
 * are offered as `module.member` calls; an unknown receiver keeps the spelling path.
 */
export const MODULES: Record<string, Record<string, Callable>> = {
  random: {
    randint: { arity: [2], params: ['number', 'number'], returns: 'number' },
    randrange: { arity: [1, 2, 3], params: ['number', 'number', 'number'], returns: 'number' },
    uniform: { arity: [2], params: ['number', 'number'], returns: 'number' },
    random: { arity: [0], returns: 'number' },
    choice: { arity: [1], params: ['list'] },
    sample: { arity: [2], params: ['list', 'number'], returns: 'list' },
    shuffle: { arity: [1], params: ['list'], returns: 'none' },
    seed: { arity: [0, 1], returns: 'none' },
  },
  math: {
    sqrt: { arity: [1], params: ['number'], returns: 'number' },
    floor: { arity: [1], params: ['number'], returns: 'number' },
    ceil: { arity: [1], params: ['number'], returns: 'number' },
    fabs: { arity: [1], params: ['number'], returns: 'number' },
    factorial: { arity: [1], params: ['number'], returns: 'number' },
    gcd: { arity: [2], params: ['number', 'number'], returns: 'number' },
    pow: { arity: [2], params: ['number', 'number'], returns: 'number' },
    log: { arity: [1, 2], params: ['number', 'number'], returns: 'number' },
    sin: { arity: [1], params: ['number'], returns: 'number' },
    cos: { arity: [1], params: ['number'], returns: 'number' },
    isclose: { arity: [2], params: ['number', 'number'], returns: 'bool' },
  },
  time: {
    time: { arity: [0], returns: 'number' },
    perf_counter: { arity: [0], returns: 'number' },
    sleep: { arity: [1], params: ['number'], returns: 'none' },
  },
  os: {
    getcwd: { arity: [0], returns: 'string' },
    getenv: { arity: [1, 2], params: ['string', 'string'], returns: 'string' },
    listdir: { arity: [0, 1], params: ['string'], returns: 'list' },
    mkdir: { arity: [1], params: ['string'], returns: 'none' },
    makedirs: { arity: [1], params: ['string'], returns: 'none' },
    remove: { arity: [1], params: ['string'], returns: 'none' },
    rmdir: { arity: [1], params: ['string'], returns: 'none' },
    rename: { arity: [2], params: ['string', 'string'], returns: 'none' },
  },
  sys: {
    exit: { arity: [0, 1], params: ['number'], returns: 'none' },
  },
  json: {
    dumps: { arity: [1], returns: 'string' },
    loads: { arity: [1], params: ['string'] },
    dump: { arity: [2], returns: 'none' },
    load: { arity: [1] },
  },
  pathlib: {
    Path: { arity: [1], params: ['string'] },
  },
  datetime: {
    datetime: { arity: [3, 4, 5, 6, 7], params: ['number', 'number', 'number'] },
    date: { arity: [3], params: ['number', 'number', 'number'] },
    timedelta: { arity: [0, 1] },
  },
  collections: {
    Counter: { arity: [0, 1] },
    defaultdict: { arity: [1] },
    deque: { arity: [0, 1] },
  },
  re: {
    match: { arity: [2], params: ['string', 'string'] },
    search: { arity: [2], params: ['string', 'string'] },
    findall: { arity: [2], params: ['string', 'string'], returns: 'list' },
    sub: { arity: [3], params: ['string', 'string', 'string'], returns: 'string' },
    compile: { arity: [1], params: ['string'] },
  },
  itertools: {
    count: { arity: [0, 1, 2], params: ['number', 'number'] },
    repeat: { arity: [1, 2], params: ['unknown', 'number'] },
    chain: { arity: [1, 2], params: ['list', 'list'] },
    product: { arity: [1, 2], params: ['list', 'list'] },
    islice: { arity: [2, 3], params: ['list', 'number', 'number'] },
  },
};

export const builtinCallable = (id: string): Callable | undefined => BUILTINS[id];
export const moduleMembers = (module: string): Record<string, Callable> | undefined => MODULES[module];

/**
 * Value and callee narrowing, mirroring `fits` in `src/lang/core.ts`: an unknown-typed value may fit
 * any expectation (untyped Python proves nothing either way), while a known type must match.
 */
export const fits = (expect: PythonType | undefined, actual: PythonType): boolean =>
  expect === undefined || expect === 'unknown' || actual === expect || actual === 'unknown';

const parameterName = (index: number, count: number): string => count === 1 ? 'x' : ['a', 'b', 'c'][index] ?? `arg${index + 1}`;

/** One-line signature for a member pick: arity, parameter types, and the common return type. */
export const memberLabel = (module: string, id: string, callable: Callable): string => {
  const result = callable.returns === undefined || callable.returns === 'unknown' ? '' : ` -> ${callable.returns}`;
  if (callable.arity.length > 1) return `${module}.${id}(${callable.arity.join(' or ')} arguments)${result}`;
  const count = callable.arity[0]!;
  const params = (callable.params ?? []).slice(0, count).map((type, index) => `${parameterName(index, count)}: ${type}`);
  return `${module}.${id}(${params.join(', ')})${result}`;
};

/**
 * Member pick criteria for one module receiver, narrowed by the expected type when one is known.
 * When no member of the module fits (the receiver may not match its table), every member is offered.
 */
export const memberCriteria = (module: string, expect?: PythonType): Record<string, string> => {
  const members = MODULES[module] ?? {};
  const entries = Object.entries(members);
  const fitting = entries.filter(([, callable]) => fits(expect, callable.returns ?? 'unknown'));
  const offered = fitting.length ? fitting : entries;
  return Object.fromEntries(offered.map(([id, callable]) => [id, memberLabel(module, id, callable)]));
};

/** True when at least one curated member could produce the expected type; gates the member callee. */
export const anyMemberFits = (expect?: PythonType): boolean =>
  expect === undefined || expect === 'unknown'
  || Object.values(MODULES).some(members => Object.values(members).some(callable => fits(expect, callable.returns ?? 'unknown')));
