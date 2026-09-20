import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PENDING } from '../decision-context.js';
import { group, adapterFor, BIN, CMP, typeOf, type Dialect, type Expr, type Program, type Stmt, type Symbol, type ValueType } from './core.js';
import { runTool, withTempDir } from './toolchain.js';

const keywords = new Set('auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while inline restrict _Bool _Complex _Imaginary _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local bool true false NULL main printf'.split(' '));

type Syms = Record<string, Symbol>;
interface Need { stdio: boolean; stdbool: boolean }

const ctype = (t: ValueType | 'void', need: Need): string => {
  if (t === 'bool') need.stdbool = true;
  return t === 'string' ? 'const char *' : t === 'bool' ? 'bool' : t === 'void' ? 'void' : 'long';
};
const decl = (t: string, id: string): string => t.endsWith('*') ? `${t}${id}` : `${t} ${id}`;

const expr = (e: Expr, need: Need): string => {
  switch (e.kind) {
    case 'hole': return PENDING;
    case 'string': return JSON.stringify(e.value);
    case 'number': return e.value < 0 ? `(${e.value}L)` : `${e.value}L`;
    case 'bool': need.stdbool = true; return String(e.value);
    case 'name': return e.id;
    case 'binary': return `${group(e.left, expr(e.left, need))} ${BIN[e.op]} ${group(e.right, expr(e.right, need))}`;
    case 'compare': return `${group(e.left, expr(e.left, need))} ${CMP[e.op]} ${group(e.right, expr(e.right, need))}`;
    case 'call': return `${e.callee}(${e.args.map(a => expr(a, need)).join(', ')})`;
    case 'list': return `{${e.items.map(a => expr(a, need)).join(', ')}}`;
    case 'index': return `${expr(e.target, need)}[${expr(e.index, need)}]`;
  }
};

const print = (e: Expr, syms: Syms, need: Need): string => {
  need.stdio = true;
  const t = typeOf(e, syms);
  const v = expr(e, need);
  if (t === 'number') return `printf("%ld\\n", ${v});`;
  if (t === 'bool') return `printf("%s\\n", (${v}) ? "true" : "false");`;
  return `printf("%s\\n", ${v});`;
};

const stmt = (s: Stmt, indent: string, syms: Syms, need: Need): string[] => {
  const inner = (body: Stmt[], scope: Syms): string[] => body.length ? body.flatMap(b => stmt(b, indent + '  ', scope, need)) : [`${indent}  ${PENDING};`];
  const block = (body: Stmt[]): string[] => inner(body, { ...syms });
  switch (s.kind) {
    case 'hole': return [`${indent}${PENDING};`];
    case 'print': return [`${indent}${print(s.value, syms, need)}`];
    case 'expr': return [`${indent}${expr(s.value, need)};`];
    case 'assign':
      if (s.declare) syms[s.id] = { kind: 'variable', type: s.type };
      return [`${indent}${s.declare ? decl(ctype(s.type, need), s.id) : s.id} = ${expr(s.value, need)};`];
    case 'if': return [`${indent}if (${expr(s.test, need)}) {`, ...block(s.body), ...(s.orelse.length ? [`${indent}} else {`, ...block(s.orelse)] : []), `${indent}}`];
    case 'while': return [`${indent}while (${expr(s.test, need)}) {`, ...block(s.body), `${indent}}`];
    case 'range': return [`${indent}for (long ${s.id} = ${expr(s.start, need)}; ${s.id} < ${expr(s.stop, need)}; ${s.id}++) {`, ...inner(s.body, { ...syms, [s.id]: { kind: 'variable', type: 'number' } }), `${indent}}`];
    case 'foreach': throw new Error('C has no foreach.');
    case 'return': return [`${indent}return${s.value ? ` ${expr(s.value, need)}` : ''};`];
    case 'break': return [`${indent}break;`];
    case 'continue': return [`${indent}continue;`];
    case 'function': {
      syms[s.id] = { kind: 'function', type: 'unknown', returns: s.returns };
      const scope: Syms = { ...syms };
      const params = s.params.map((p, i) => {
        const t = s.paramTypes[i] ?? 'number';
        scope[p] = { kind: 'parameter', type: t };
        return decl(ctype(t, need), p);
      });
      return [`${indent}${decl(ctype(s.returns, need), s.id)}(${params.length ? params.join(', ') : 'void'}) {`, ...inner(s.body, scope), `${indent}}`];
    }
  }
};

const render = (program: Program): string => {
  const need: Need = { stdio: false, stdbool: false };
  const syms: Syms = {};
  const fns: string[][] = [];
  const main: string[] = [];
  for (const s of program.body) {
    if (s.kind === 'function') fns.push(stmt(s, '', syms, need));
    else main.push(...stmt(s, '  ', syms, need));
  }
  const includes = [...(need.stdio ? ['#include <stdio.h>'] : []), ...(need.stdbool ? ['#include <stdbool.h>'] : [])];
  const groups = [...(includes.length ? [includes] : []), ...fns, ['int main(void) {', ...main, '  return 0;', '}']];
  return groups.map(g => g.join('\n')).join('\n\n') + '\n';
};

const isEnoent = (err: unknown): boolean => typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';

const compile = (bin: string, file: string, signal: AbortSignal): Promise<void> =>
  runTool(bin, ['-fsyntax-only', '-Wall', '-Werror=implicit-function-declaration', '-x', 'c', file], { name: 'C', signal, timeout: 20_000 });

const validate = async (source: string, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  await withTempDir('jev-c-', async dir => {
    const file = join(dir, 'main.c');
    await writeFile(file, source);
    try {
      await compile('gcc', file, signal);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      try {
        await compile('clang', file, signal);
      } catch (alt) {
        if (isEnoent(alt)) throw new Error('C validation needs gcc or clang on PATH.');
        throw alt;
      }
    }
  });
};

export const cDialect: Dialect = {
  id: 'c', name: 'C', extensions: ['.c'], languages: ['c'],
  keywords, builtins: {},
  features: { functions: true, while: true, range: true, foreach: false, list: false, index: false, compareStrings: false, concat: false },
  typed: true, render, validate,
};

export const cAstAdapter = adapterFor(cDialect);
