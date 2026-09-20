import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PENDING } from '../decision-context.js';
import { adapterFor, exprRenderer, type Dialect, type Program, type Stmt, type ValueType } from './core.js';
import { runTool, withTempDir } from './toolchain.js';

const keywords = new Set('as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try gen union macro_rules raw safe main println'.split(' '));

const types: Partial<Record<ValueType, string>> = { number: 'i64', string: '&str', bool: 'bool' };
const annotate = (type: ValueType): string => types[type] ? `: ${types[type]}` : '';

const expr = exprRenderer({ list: items => `vec![${items.join(', ')}]` });

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
  await withTempDir('jev-rust-', async dir => {
    await writeFile(join(dir, 'main.rs'), source);
    const args = ['--edition', '2021', '--crate-type', 'bin', '--emit=metadata', '-o', join(dir, 'out'), 'main.rs'];
    await runTool('rustc', args, { name: 'Rust', signal, timeout: 30_000, cwd: dir, missing: 'Rust validation needs rustc on PATH.' });
  });
};

const features: Dialect['features'] = { functions: true, while: true, range: true, foreach: false, list: false, index: false, compareStrings: false, concat: false };

export const rustDialect: Dialect = {
  id: 'rust', name: 'Rust', extensions: ['.rs'], languages: ['rust'],
  keywords, builtins: {}, features, typed: true, render, validate,
};

export const rustAstAdapter = adapterFor(rustDialect);
