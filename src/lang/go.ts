import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PENDING } from '../decision-context.js';
import { sanitizedEnv } from '../env.js';
import { group, adapterFor, BIN, CMP, type Dialect, type Expr, type Program, type Stmt, type ValueType } from './core.js';

const keywords = new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var main fmt len append make nil int string bool true false'.split(' '));

const goType = (t: ValueType): string => t === 'string' ? 'string' : t === 'bool' ? 'bool' : 'int';

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
    case 'list': return `[]int{${e.items.map(expr).join(', ')}}`;
    case 'index': return `${expr(e.target)}[${expr(e.index)}]`;
  }
};

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
  const dir = await mkdtemp(join(tmpdir(), 'jev-go-'));
  try {
    await writeFile(join(dir, 'go.mod'), 'module jev\n\ngo 1.21\n');
    await writeFile(join(dir, 'main.go'), source);
    await new Promise<void>((resolve, reject) => {
      const env = { ...sanitizedEnv(), GOFLAGS: '-mod=mod', GO111MODULE: 'on', GOCACHE: join(tmpdir(), 'jev-gocache') };
      const child = spawn('go', ['vet', './...'], { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'], signal, timeout: 60_000 });
      let err = '';
      child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-8000); });
      child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new Error('Go validation needs go on PATH.') : e));
      child.on('close', code => {
        if (signal.aborted) { reject(signal.reason); return; }
        if (code !== 0) { reject(new Error(`Go validation failed: ${err.trim() || `exit ${code}`}`)); return; }
        resolve();
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const features: Dialect['features'] = { functions: true, while: true, range: true, foreach: false, list: false, index: false, compareStrings: false, concat: false };

export const goDialect: Dialect = {
  id: 'go', name: 'Go', extensions: ['.go'], languages: ['go', 'golang'],
  keywords, builtins: {}, features, typed: true, render, validate,
};

export const goAstAdapter = adapterFor(goDialect);
