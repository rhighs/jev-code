import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PENDING } from '../decision-context.js';
import { adapterFor, exprRenderer, type Dialect, type Program, type Stmt } from './core.js';
import { runTool, withTempDir } from './toolchain.js';

const keywords = new Set('__ENCODING__ __LINE__ __FILE__ BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield puts print p require gets'.split(' '));

const builtins: Dialect['builtins'] = {
  Integer: { arity: [1], returns: 'number' },
  String: { arity: [1], returns: 'string' },
};

const str = (v: string): string => JSON.stringify(v).replace(/#/g, '\\#');

const expr = exprRenderer({ list: items => `[${items.join(', ')}]`, str });

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

const validate = async (source: string, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  await withTempDir('jev-ruby-', async dir => {
    const file = join(dir, 'main.rb');
    await writeFile(file, source, 'utf8');
    await runTool('ruby', ['-c', file], { name: 'Ruby', signal, timeout: 10_000, missing: 'Ruby validation needs ruby on PATH.' });
  });
};

const features: Dialect['features'] = { functions: true, while: true, range: true, foreach: true, list: true, index: true, compareStrings: true, concat: true };

export const rubyDialect: Dialect = {
  id: 'ruby', name: 'Ruby', extensions: ['.rb'], languages: ['ruby'],
  keywords, builtins, features, typed: false, render, validate,
};

export const rubyAstAdapter = adapterFor(rubyDialect);
