import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PENDING } from '../decision-context.js';
import { adapterFor, exprRenderer, type Dialect, type Program, type Stmt, type ValueType } from './core.js';
import { runTool, withTempDir } from './toolchain.js';

const keywords = new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var main fmt len append make nil int string bool true false'.split(' '));

const goType = (t: ValueType): string => t === 'string' ? 'string' : t === 'bool' ? 'bool' : 'int';

const expr = exprRenderer({ list: items => `[]int{${items.join(', ')}}` });

const block = (body: Stmt[], indent: string): string[] => body.length ? body.filter(s => s.kind !== 'function').flatMap(s => stmt(s, indent)) : [`${indent}${PENDING}`];

const stmt = (s: Stmt, indent: string): string[] => {
  const inner = (body: Stmt[]): string[] => block(body, indent + '\t');
  switch (s.kind) {
    case 'hole': return [`${indent}${PENDING}`];
    case 'print': return [`${indent}fmt.Println(${expr(s.value)})`];
    case 'expr': return [`${indent}${expr(s.value)}`];
    case 'assign': return s.declare ? [`${indent}${s.id} := ${expr(s.value)}`, `${indent}_ = ${s.id}`] : [`${indent}${s.id} = ${expr(s.value)}`];
    case 'if': return [`${indent}if ${expr(s.test)} {`, ...inner(s.body), ...(s.orelse.length ? [`${indent}} else {`, ...inner(s.orelse)] : []), `${indent}}`];
    case 'while': return [`${indent}for ${expr(s.test)} {`, ...inner(s.body), `${indent}}`];
    case 'range': return [`${indent}for ${s.id} := ${expr(s.start)}; ${s.id} < ${expr(s.stop)}; ${s.id}++ {`, `${indent}\t_ = ${s.id}`, ...inner(s.body), `${indent}}`];
    case 'foreach': return [`${indent}for _, ${s.id} := range ${expr(s.iterable)} {`, ...inner(s.body), `${indent}}`];
    case 'return': return [`${indent}return${s.value ? ` ${expr(s.value)}` : ''}`];
    case 'break': return [`${indent}break`];
    case 'continue': return [`${indent}continue`];
    case 'function': return [`${indent}func ${s.id}(${s.params.map((p, i) => `${p} ${goType(s.paramTypes[i] ?? 'number')}`).join(', ')})${s.returns === 'void' ? '' : ` ${goType(s.returns)}`} {`, ...inner(s.body), `${indent}}`];
  }
};

const walk = (body: Stmt[], f: (s: Stmt) => void): void => {
  for (const s of body) {
    f(s);
    if ('body' in s) walk(s.body, f);
    if (s.kind === 'if') walk(s.orelse, f);
  }
};

const render = (program: Program): string => {
  const fns: Stmt[] = [];
  let prints = false;
  walk(program.body, s => { if (s.kind === 'function') fns.push(s); if (s.kind === 'print') prints = true; });
  return ['package main', '', ...(prints ? ['import "fmt"', ''] : []), ...fns.flatMap(f => [...stmt(f, ''), '']), 'func main() {', ...block(program.body, '\t'), '}'].join('\n') + '\n';
};

const validate = async (source: string, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  await withTempDir('jev-go-', async dir => {
    await writeFile(join(dir, 'go.mod'), 'module jev\n\ngo 1.21\n');
    await writeFile(join(dir, 'main.go'), source);
    const env = { GOFLAGS: '-mod=mod', GO111MODULE: 'on', GOCACHE: join(tmpdir(), 'jev-gocache') };
    await runTool('go', ['vet', './...'], { name: 'Go', signal, timeout: 60_000, cwd: dir, env, missing: 'Go validation needs go on PATH.' });
  });
};

const features: Dialect['features'] = { functions: true, while: true, range: true, foreach: false, list: false, index: false, compareStrings: false, concat: false };

export const goDialect: Dialect = {
  id: 'go', name: 'Go', extensions: ['.go'], languages: ['go', 'golang'],
  keywords, builtins: {}, features, typed: true, render, validate,
};

export const goAstAdapter = adapterFor(goDialect);
