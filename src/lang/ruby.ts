import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PENDING } from '../decision-context.js';
import { sanitizedEnv } from '../env.js';
import { group, adapterFor, BIN, CMP, type Dialect, type Expr, type Program, type Stmt } from './core.js';

const keywords = new Set('__ENCODING__ __LINE__ __FILE__ BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield puts print p require gets'.split(' '));

const builtins: Dialect['builtins'] = {
  Integer: { arity: [1], returns: 'number' },
  String: { arity: [1], returns: 'string' },
};

const str = (v: string): string => JSON.stringify(v).replace(/#/g, '\\#');

const expr = (e: Expr): string => {
  switch (e.kind) {
    case 'hole': return PENDING;
    case 'string': return str(e.value);
    case 'number': return e.value < 0 ? `(${e.value})` : String(e.value);
    case 'bool': return String(e.value);
    case 'name': return e.id;
    case 'binary': return `${group(e.left, expr(e.left))} ${BIN[e.op]} ${group(e.right, expr(e.right))}`;
    case 'compare': return `${group(e.left, expr(e.left))} ${CMP[e.op]} ${group(e.right, expr(e.right))}`;
    case 'call': return `${e.callee}(${e.args.map(expr).join(', ')})`;
    case 'list': return `[${e.items.map(expr).join(', ')}]`;
    case 'index': return `${expr(e.target)}[${expr(e.index)}]`;
  }
};

const stmt = (s: Stmt, indent: string): string[] => {
  const inner = (body: Stmt[]): string[] => body.length ? body.flatMap(b => stmt(b, indent + '  ')) : [`${indent}  ${PENDING}`];
  switch (s.kind) {
    case 'hole': return [`${indent}${PENDING}`];
    case 'print': return [`${indent}puts ${expr(s.value)}`];
    case 'expr': return [`${indent}${expr(s.value)}`];
    case 'assign': return [`${indent}${s.id} = ${expr(s.value)}`];
    case 'if': return [`${indent}if ${expr(s.test)}`, ...inner(s.body), ...(s.orelse.length ? [`${indent}else`, ...inner(s.orelse)] : []), `${indent}end`];
    case 'while': return [`${indent}while ${expr(s.test)}`, ...inner(s.body), `${indent}end`];
    case 'range': return [`${indent}(${expr(s.start)}...${expr(s.stop)}).each do |${s.id}|`, ...inner(s.body), `${indent}end`];
    case 'foreach': return [`${indent}${expr(s.iterable)}.each do |${s.id}|`, ...inner(s.body), `${indent}end`];
    case 'return': return [`${indent}return${s.value ? ` ${expr(s.value)}` : ''}`];
    case 'break': return [`${indent}break`];
    case 'continue': return [`${indent}next`];
    case 'function': return [`${indent}def ${s.id}(${s.params.join(', ')})`, ...inner(s.body), `${indent}end`];
  }
};

const render = (program: Program): string => program.body.flatMap(s => stmt(s, '')).join('\n') + (program.body.length ? '\n' : '');

const check = (file: string, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn('ruby', ['-c', file], { signal, timeout: 10_000, env: sanitizedEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-8000); });
  child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new Error('Ruby validation needs ruby on PATH.') : e));
  child.on('close', code => {
    if (signal.aborted) reject(signal.reason);
    else if (code === 0) resolve();
    else reject(new Error(`Ruby syntax validation failed: ${err.trim() || `exit ${code}`}`));
  });
});

const validate = async (source: string, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), 'jev-ruby-'));
  try {
    const file = join(dir, 'main.rb');
    await writeFile(file, source, 'utf8');
    await check(file, signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const features: Dialect['features'] = { functions: true, while: true, range: true, foreach: true, list: true, index: true, compareStrings: true, concat: true };

export const rubyDialect: Dialect = {
  id: 'ruby', name: 'Ruby', extensions: ['.rb'], languages: ['ruby'],
  keywords, builtins, features, typed: false, render, validate,
};

export const rubyAstAdapter = adapterFor(rubyDialect);
