import assert from 'node:assert/strict';
import test from 'node:test';
import type { Dialect } from '../src/lang/core.js';
import { javascriptDialect, typescriptDialect } from '../src/lang/javascript.js';

import { fullScript, run, type Script } from './lang-helpers.js';

test('the JavaScript dialect renders every production with holes marked while building', async () => {
  const previews: string[] = [];
  const dialect: Dialect = { ...javascriptDialect, render: p => { const s = javascriptDialect.render(p); previews.push(s); return s; } };
  const source = await run(dialect, 'add numbers and print the total.', fullScript);
  assert.equal(source, [
    'let total = 0;',
    'function add(a, b) {',
    '  if (b > 0) {',
    '    return b;',
    '  }',
    '  return b + 0;',
    '}',
    'for (let i = 0; i < 0; i++) {',
    '  total = 0;',
    '}',
    'while (total > 0) {',
    '  break;',
    '}',
    'console.log(add(total, 0));',
    '',
  ].join('\n'));
  assert.ok(previews.some(p => p.includes('__jev_pending__')));
  await javascriptDialect.validate(source, new AbortController().signal);
});

test('the TypeScript dialect annotates declarations and parameters', async () => {
  const source = await run(typescriptDialect, 'add numbers and print the total.', fullScript);
  assert.match(source, /^let total: number = 0;/);
  assert.match(source, /function add\(a, b\) \{/);
  await typescriptDialect.validate(source, new AbortController().signal);
  await assert.rejects(typescriptDialect.validate('let = ;', new AbortController().signal));
});

test('a custom string is composed from tokens and lists are indexed', async () => {
  const source = await run(javascriptDialect, 'Print hello.', ({ slot, criteria }, n) => {
    if (slot === 'module_body') return ['assign', 'print', 'print', 'finish'][n] ?? 'finish';
    if (slot === 'assignment_name') return 'items';
    if (slot === 'value') return 'list';
    if (slot === 'element_count') return '2';
    if (slot.startsWith('element_')) return 'number';
    if (slot === 'number') return n === 1 ? '2' : '1';
    if (slot === 'printed') return n === 0 ? 'index' : 'string';
    if (slot === 'object') return 'name';
    if (slot === 'index') return 'number';
    if (slot === 'string') return 'custom';
    if (slot.startsWith('string_token')) { const partial = JSON.parse(slot.slice('string_token:'.length)) as string; return partial === '' ? 'Print' : partial === 'Print' ? ' ' : partial === 'Print ' ? 'hello' : 'end'; }
    return criteria[0]!;
  });
  assert.equal(source, 'let items = [1, 2];\nconsole.log(items[1]);\nconsole.log("Print hello");\n');
});

test('the step budget is enforced', async () => {
  await assert.rejects(run(javascriptDialect, 'Loop.', fullScript, 3), /budget/);
});
