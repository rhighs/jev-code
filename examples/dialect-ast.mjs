// Build the harness first: npm run build
// A dialect supplies keywords, builtins, features, a renderer and a validator; the core builds the program.
import { adapterFor } from '../dist/index.js';

const PENDING = '__jev_pending__';
const expr = e => {
  switch (e.kind) {
    case 'hole': return PENDING;
    case 'string': return JSON.stringify(e.value);
    case 'number': return String(e.value);
    case 'bool': return e.value ? '#t' : '#f';
    case 'name': return e.id;
    case 'binary': return `(${e.op === 'concat' ? 'string-append' : { add: '+', sub: '-', mul: '*', div: '/', mod: 'modulo' }[e.op]} ${expr(e.left)} ${expr(e.right)})`;
    case 'compare': return `(${{ eq: '=', ne: '/=', lt: '<', le: '<=', gt: '>', ge: '>=' }[e.op]} ${expr(e.left)} ${expr(e.right)})`;
    case 'call': return `(${e.callee}${e.args.map(a => ` ${expr(a)}`).join('')})`;
    case 'list': return `(list${e.items.map(i => ` ${expr(i)}`).join('')})`;
    case 'index': return `(list-ref ${expr(e.target)} ${expr(e.index)})`;
  }
};
const stmt = (s, indent) => {
  const inner = body => body.length ? body.flatMap(b => stmt(b, indent + '  ')) : [`${indent}  ${PENDING}`];
  switch (s.kind) {
    case 'hole': return [`${indent}${PENDING}`];
    case 'print': return [`${indent}(displayln ${expr(s.value)})`];
    case 'expr': return [`${indent}${expr(s.value)}`];
    case 'assign': return [`${indent}(${s.declare ? 'define' : 'set!'} ${s.id} ${expr(s.value)})`];
    case 'if': return [`${indent}(if ${expr(s.test)}`, `${indent}  (begin`, ...inner(s.body), `${indent}  )`, `${indent}  (begin`, ...(s.orelse.length ? inner(s.orelse) : [`${indent}    (void)`]), `${indent}  ))`];
    case 'while': return [`${indent}(let loop () (when ${expr(s.test)}`, ...inner(s.body), `${indent}  (loop)))`];
    case 'range': return [`${indent}(for ([${s.id} (in-range ${expr(s.start)} ${expr(s.stop)})])`, ...inner(s.body), `${indent})`];
    case 'foreach': return [`${indent}(for ([${s.id} ${expr(s.iterable)}])`, ...inner(s.body), `${indent})`];
    case 'return': return [`${indent}${s.value ? expr(s.value) : '(void)'}`];
    case 'break': case 'continue': return [`${indent}(void)`];
    case 'function': return [`${indent}(define (${s.id}${s.params.map(p => ` ${p}`).join('')})`, ...inner(s.body), `${indent})`];
  }
};

const racketDialect = {
  id: 'racket', name: 'Racket', extensions: ['.rkt'], languages: ['racket', 'scheme'],
  keywords: new Set(['define', 'lambda', 'if', 'let', 'set!', 'begin', 'when', 'for', 'list', 'displayln']),
  builtins: { 'number->string': { arity: [1], returns: 'string', params: ['number'] } },
  features: { functions: true, while: true, range: true, foreach: true, list: true, index: true, compareStrings: false, concat: true },
  typed: false,
  render: program => `#lang racket\n${program.body.flatMap(s => stmt(s, '')).join('\n')}\n`,
  async validate(source, signal) {
    signal.throwIfAborted();
    let depth = 0;
    for (const ch of source) { if (ch === '(') depth++; if (ch === ')') depth--; if (depth < 0) throw new Error('Unbalanced parenthesis.'); }
    if (depth !== 0) throw new Error('Unbalanced parenthesis.');
  },
};

export const astAdapters = [adapterFor(racketDialect)];
