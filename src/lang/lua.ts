import { spawn } from 'node:child_process';
import { PENDING } from '../decision-context.js';
import { sanitizedEnv } from '../env.js';
import { adapterFor, BIN, CMP, exprRenderer, type BinOp, type CmpOp, type Dialect, type Expr, type Program, type Stmt } from './core.js';

const keywords = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while print ipairs pairs tostring tonumber string table math'.split(' '));

const builtins: Dialect['builtins'] = {
  tostring: { arity: [1], returns: 'string' },
  tonumber: { arity: [1], returns: 'number' },
};

const BIN_LUA: Record<BinOp, string> = { ...BIN, concat: '..' };
const CMP_LUA: Record<CmpOp, string> = { ...CMP, ne: '~=' };

const str = (v: string): string => JSON.stringify(v).replace(/\\u([0-9a-fA-F]{4})/g, '\\u{$1}');

const prefix = (e: Expr): string => e.kind === 'name' || e.kind === 'call' || e.kind === 'index' || e.kind === 'hole' ? expr(e) : `(${expr(e)})`;

export const expr: (e: Expr) => string = exprRenderer({
  list: items => `{${items.join(', ')}}`, str, bin: BIN_LUA, cmp: CMP_LUA,
  index: (e, expr) => `${prefix(e.target)}[(${expr(e.index)}) + 1]`,
});

const stmt = (s: Stmt, indent: string): string[] => {
  const inner = (body: Stmt[]): string[] => body.length ? body.flatMap(b => stmt(b, indent + '  ')) : [`${indent}  ${PENDING}`];
  const loop = (body: Stmt[]): string[] => {
    const last = body[body.length - 1];
    const head = body.slice(0, -1).flatMap(b => stmt(b, indent + '  '));
    const lines = last?.kind === 'return' ? [...head, `${indent}  do ${stmt(last, '')[0]} end`] : inner(body);
    return [...lines, `${indent}  ::continue_label::`, `${indent}end`];
  };
  switch (s.kind) {
    case 'hole': return [`${indent}${PENDING}`];
    case 'print': return [`${indent}print(${expr(s.value)})`];
    case 'expr': return [`${indent}${expr(s.value)}`];
    case 'assign': return [`${indent}${s.declare ? 'local ' : ''}${s.id} = ${expr(s.value)}`];
    case 'if': return [`${indent}if ${expr(s.test)} then`, ...inner(s.body), ...(s.orelse.length ? [`${indent}else`, ...inner(s.orelse)] : []), `${indent}end`];
    case 'while': return [`${indent}while ${expr(s.test)} do`, ...loop(s.body)];
    case 'range': return [`${indent}for ${s.id} = ${expr(s.start)}, (${expr(s.stop)}) - 1 do`, ...loop(s.body)];
    case 'foreach': return [`${indent}for _, ${s.id} in ipairs(${expr(s.iterable)}) do`, ...loop(s.body)];
    case 'return': return [`${indent}return${s.value ? ` ${expr(s.value)}` : ''}`];
    case 'break': return [`${indent}break`];
    case 'continue': return [`${indent}goto continue_label`];
    case 'function': return [`${indent}local function ${s.id}(${s.params.join(', ')})`, ...inner(s.body), `${indent}end`];
  }
};

const render = (program: Program): string => program.body.flatMap(s => stmt(s, '')).join('\n') + (program.body.length ? '\n' : '');

const parse = (cmd: string, args: string[], source: string, signal: AbortSignal): Promise<boolean> => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { env: sanitizedEnv(), stdio: ['pipe', 'pipe', 'pipe'], signal, timeout: 10_000 });
  let err = '', done = false;
  const settle = (fn: () => void): void => { if (done) return; done = true; fn(); };
  child.on('error', (e: NodeJS.ErrnoException) => settle(() => e.code === 'ENOENT' ? resolve(false) : reject(e)));
  child.stdin.on('error', (e: Error) => settle(() => { child.kill('SIGKILL'); reject(e); }));
  child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-8000); });
  child.on('close', code => settle(() => {
    if (signal.aborted) { reject(signal.reason); return; }
    if (code !== 0) { reject(new Error(`Lua validation failed: ${err.trim() || `exit ${code}`}`)); return; }
    resolve(true);
  }));
  child.stdin.end(source);
});

const validate = async (source: string, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  if (await parse('luac', ['-p', '-'], source, signal)) return;
  if (await parse('lua', ['-e', "assert(load(io.read('*a'), '=main.lua'))"], source, signal)) return;
  throw new Error('Lua validation needs luac or lua on PATH.');
};

const features: Dialect['features'] = { functions: true, while: true, range: true, foreach: true, list: true, index: true, compareStrings: true, concat: true };

export const luaDialect: Dialect = {
  id: 'lua', name: 'Lua', extensions: ['.lua'], languages: ['lua'],
  keywords, builtins, features, typed: false, render, validate,
};

export const luaAstAdapter = adapterFor(luaDialect);
