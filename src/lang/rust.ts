import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PENDING } from '../decision-context.js';
import { sanitizedEnv } from '../env.js';
import { group, adapterFor, BIN, CMP, type Dialect, type Expr, type Program, type Stmt, type ValueType } from './core.js';

const keywords = new Set('as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try gen union macro_rules raw safe main println'.split(' '));

const types: Partial<Record<ValueType, string>> = { number: 'i64', string: '&str', bool: 'bool' };
const annotate = (type: ValueType): string => types[type] ? `: ${types[type]}` : '';

const expr = (e: Expr): string => {
  switch (e.kind) {
    case 'hole': return PENDING;
    case 'string': return JSON.stringify(e.value);
    case 'number': return e.value < 0 ? `(${e.value})` : String(e.value);
    case 'bool': return String(e.value);
    case 'name': return e.id;
    case 'binary': return `${group(e.left, expr(e.left))} ${BIN[e.op]} ${group(e.right, expr(e.right))}`;
    case 'compare': return `${group(e.left, expr(e.left))} ${CMP[e.op]} ${group(e.right, expr(e.right))}`;
    case 'call': return `${e.callee}(${e.args.map(expr).join(', ')})`;
    case 'list': return `vec![${e.items.map(expr).join(', ')}]`;
    case 'index': return `${expr(e.target)}[${expr(e.index)}]`;
  }
};

const stmt = (s: Stmt, indent: string): string[] => {
  const inner = (body: Stmt[]): string[] => body.length ? body.flatMap(b => stmt(b, indent + '  ')) : [`${indent}  ${PENDING};`];
  switch (s.kind) {
    case 'hole': return [`${indent}${PENDING};`];
    case 'print': return [`${indent}println!("{}", ${expr(s.value)});`];
    case 'expr': return [`${indent}${expr(s.value)};`];
    case 'assign': return [`${indent}${s.declare ? `let mut ${s.id}${annotate(s.type)}` : s.id} = ${expr(s.value)};`];
    case 'if': return [`${indent}if ${expr(s.test)} {`, ...inner(s.body), ...(s.orelse.length ? [`${indent}} else {`, ...inner(s.orelse)] : []), `${indent}}`];
    case 'while': return [`${indent}while ${expr(s.test)} {`, ...inner(s.body), `${indent}}`];
    case 'range': return [`${indent}for ${s.id} in ${expr(s.start)}..${expr(s.stop)} {`, ...inner(s.body), `${indent}}`];
    case 'foreach': return [`${indent}for ${s.id} in ${expr(s.iterable)} {`, ...inner(s.body), `${indent}}`];
    case 'return': return [`${indent}return${s.value ? ` ${expr(s.value)}` : ''};`];
    case 'break': return [`${indent}break;`];
    case 'continue': return [`${indent}continue;`];
    case 'function': return [`${indent}fn ${s.id}(${s.params.map((p, i) => `${p}${annotate(s.paramTypes[i] ?? 'unknown')}`).join(', ')})${s.returns === 'void' ? '' : ` -> ${types[s.returns] ?? ''}`} {`, ...inner(s.body), `${indent}}`];
  }
};

const render = (program: Program): string => {
  const fns = program.body.filter(s => s.kind === 'function');
  const rest = program.body.filter(s => s.kind !== 'function');
  const main = program.body.length ? rest.flatMap(s => stmt(s, '  ')) : [`  ${PENDING};`];
  return [...fns.flatMap(s => stmt(s, '')), 'fn main() {', ...main, '}'].join('\n') + '\n';
};

const validate = async (source: string, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), 'jev-rust-'));
  try {
    await writeFile(join(dir, 'main.rs'), source);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('rustc', ['--edition', '2021', '--crate-type', 'bin', '--emit=metadata', '-o', join(dir, 'out'), 'main.rs'], { cwd: dir, env: sanitizedEnv(), stdio: ['ignore', 'ignore', 'pipe'], signal, timeout: 30_000 });
      let err = '';
      child.on('error', (reason: NodeJS.ErrnoException) => reject(reason.code === 'ENOENT' ? new Error('Rust validation needs rustc on PATH.') : reason));
      child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-8000); });
      child.on('close', code => {
        if (signal.aborted) { reject(signal.reason); return; }
        if (code !== 0) { reject(new Error(`Rust validation failed: ${err.trim() || `exit ${code}`}`)); return; }
        resolve();
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const features: Dialect['features'] = { functions: true, while: true, range: true, foreach: false, list: false, index: false, compareStrings: false, concat: false };

export const rustDialect: Dialect = {
  id: 'rust', name: 'Rust', extensions: ['.rs'], languages: ['rust'],
  keywords, builtins: {}, features, typed: true, render, validate,
};

export const rustAstAdapter = adapterFor(rustDialect);
