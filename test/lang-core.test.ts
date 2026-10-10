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

test('a task literal resolves from the enriched custom pieces in one pick', async () => {
  const source = await run(javascriptDialect, 'Print "Hello, world!".', ({ slot, criteria }) => {
    if (slot === 'module_body') return criteria.includes('finish') ? 'finish' : 'print';
    if (slot === 'printed') return 'string';
    if (slot === 'string') return 'custom';
    if (slot.startsWith('string_token')) { const partial = JSON.parse(slot.slice('string_token:'.length)) as string; return partial === '' ? 'Hello, world!' : 'end'; }
    return 'finish';
  });
  assert.equal(source, 'console.log("Hello, world!");\n');
});

test('a custom string prefers the longest matching continuation of a known literal', async () => {
  const source = await run(javascriptDialect, 'Print "Hello, world!".', ({ slot, criteria }) => {
    if (slot === 'module_body') return criteria.includes('finish') ? 'finish' : 'print';
    if (slot === 'printed') return 'string';
    if (slot === 'string') return 'custom';
    if (slot.startsWith('string_token')) {
      const partial = JSON.parse(slot.slice('string_token:'.length)) as string;
      // The first offered piece must be the longest continuation (", world!"), not " world!".
      return partial === '' ? 'Hello' : partial === 'Hello' ? criteria[0]! : 'end';
    }
    return 'finish';
  });
  assert.equal(source, 'console.log("Hello, world!");\n');
});

test('a novel literal spells from the longest task pieces in a handful of picks', async () => {
  let tokenPicks = 0;
  const source = await run(javascriptDialect, 'Print the words banana split.', ({ slot, criteria }) => {
    if (slot === 'module_body') return criteria.includes('finish') ? 'finish' : 'print';
    if (slot === 'printed') return 'string';
    if (slot === 'string') return 'custom';
    if (slot.startsWith('string_token')) {
      tokenPicks++;
      const partial = JSON.parse(slot.slice('string_token:'.length)) as string;
      return partial === '' ? 'split' : partial === 'split' ? ' ' : partial === 'split ' ? 'banana' : 'end';
    }
    return 'finish';
  });
  assert.equal(source, 'console.log("split banana");\n');
  assert.ok(tokenPicks <= 5, `a novel literal stays within a handful of token picks, got ${tokenPicks}`);
});

test('an over-budget custom string throws the shared byte-budget error', async () => {
  const long = 'x'.repeat(2400);
  await assert.rejects(run(javascriptDialect, `Print ${long}.`, ({ slot, criteria }) => {
    if (slot === 'module_body') return criteria.includes('finish') ? 'finish' : 'print';
    if (slot === 'printed') return 'string';
    if (slot === 'string') return 'custom';
    if (slot.startsWith('string_token')) { const partial = JSON.parse(slot.slice('string_token:'.length)) as string; return partial === '' ? long : 'end'; }
    return 'finish';
  }), /AST string exceeds its byte budget/);
});

test('the step budget is enforced', async () => {
  await assert.rejects(run(javascriptDialect, 'Loop.', fullScript, 3), /budget/);
});
