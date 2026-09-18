import ts from 'typescript';
import { PENDING } from '../decision-context.js';
import { adapterFor, BIN, CMP, type Dialect, type Expr, type Stmt, type ValueType } from './core.js';

const keywords = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await async of undefined NaN Infinity'.split(' '));

const builtins: Dialect['builtins'] = {
  String: { arity: [1], returns: 'string' },
  Number: { arity: [1], returns: 'number' },
  'Math.floor': { arity: [1], returns: 'number', params: ['number'] },
  'Math.abs': { arity: [1], returns: 'number', params: ['number'] },
  'Math.max': { arity: [2], returns: 'number', params: ['number', 'number'] },
  'Math.min': { arity: [2], returns: 'number', params: ['number', 'number'] },
};

const CMP_JS: Record<string, string> = { ...CMP, eq: '===', ne: '!==' };

const annotate = (typed: boolean, type: ValueType): string => {
  if (!typed) return '';
  const map: Partial<Record<ValueType, string>> = { string: 'string', number: 'number', bool: 'boolean' };
  return map[type] ? `: ${map[type]}` : '';
};

export const expr = (e: Expr): string => {
  switch (e.kind) {
    case 'hole': return PENDING;
    case 'string': return JSON.stringify(e.value);
    case 'number': return e.value < 0 ? `(${e.value})` : String(e.value);
    case 'bool': return String(e.value);
    case 'name': return e.id;
    case 'binary': return `${expr(e.left)} ${BIN[e.op]} ${expr(e.right)}`;
    case 'compare': return `${expr(e.left)} ${CMP_JS[e.op]} ${expr(e.right)}`;
    case 'call': return `${e.callee}(${e.args.map(expr).join(', ')})`;
    case 'list': return `[${e.items.map(expr).join(', ')}]`;
    case 'index': return `${expr(e.target)}[${expr(e.index)}]`;
  }
};

const renderer = (typed: boolean) => {
  const stmt = (s: Stmt, indent: string): string[] => {
    const inner = (body: Stmt[]): string[] => body.length ? body.flatMap(b => stmt(b, indent + '  ')) : [`${indent}  ${PENDING};`];
    switch (s.kind) {
      case 'hole': return [`${indent}${PENDING};`];
      case 'print': return [`${indent}console.log(${expr(s.value)});`];
      case 'expr': return [`${indent}${expr(s.value)};`];
      case 'assign': return [`${indent}${s.declare ? 'let ' : ''}${s.id}${s.declare ? annotate(typed, s.type) : ''} = ${expr(s.value)};`];
      case 'if': return [`${indent}if (${expr(s.test)}) {`, ...inner(s.body), ...(s.orelse.length ? [`${indent}} else {`, ...inner(s.orelse)] : []), `${indent}}`];
      case 'while': return [`${indent}while (${expr(s.test)}) {`, ...inner(s.body), `${indent}}`];
      case 'range': return [`${indent}for (let ${s.id} = ${expr(s.start)}; ${s.id} < ${expr(s.stop)}; ${s.id}++) {`, ...inner(s.body), `${indent}}`];
      case 'foreach': return [`${indent}for (const ${s.id} of ${expr(s.iterable)}) {`, ...inner(s.body), `${indent}}`];
      case 'return': return [`${indent}return${s.value ? ` ${expr(s.value)}` : ''};`];
      case 'break': return [`${indent}break;`];
      case 'continue': return [`${indent}continue;`];
      case 'function': return [`${indent}function ${s.id}(${s.params.map((p, i) => `${p}${annotate(typed, s.paramTypes[i] ?? 'unknown')}`).join(', ')})${typed && s.returns !== 'void' ? annotate(true, s.returns) : ''} {`, ...inner(s.body), `${indent}}`];
    }
  };
  return (program: { body: Stmt[] }): string => program.body.flatMap(s => stmt(s, '')).join('\n') + (program.body.length ? '\n' : '');
};

const validate = (fileName: string) => async (source: string, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  const errors = ts.transpileModule(source, { fileName, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, allowJs: true } }).diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
};

const features: Dialect['features'] = { functions: true, while: true, range: true, foreach: true, list: true, index: true, compareStrings: true, concat: true };

export const javascriptDialect: Dialect = {
  id: 'javascript', name: 'JavaScript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], languages: ['javascript', 'js', 'node'],
  keywords, builtins, features, typed: false, render: renderer(false), validate: validate('main.js'),
};

export const typescriptDialect: Dialect = {
  id: 'typescript', name: 'TypeScript', extensions: ['.ts', '.tsx', '.mts', '.cts'], languages: ['typescript', 'ts'],
  keywords, builtins, features, typed: false, render: renderer(true), validate: validate('main.ts'),
};

export const javascriptAstAdapter = adapterFor(javascriptDialect);
export const typescriptAstAdapter = adapterFor(typescriptDialect);
