import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { Dialect } from '../src/lang/core.js';
import { cAstAdapter, cDialect } from '../src/lang/c.js';
import { typescriptDialect } from '../src/lang/javascript.js';
import { run, type Script } from './lang-helpers.js';

const hasCompiler = ['gcc', 'clang'].some(bin => spawnSync(bin, ['--version'], { stdio: 'ignore' }).error === undefined);

const script: Script = ({ slot, criteria }, n) => {
  switch (slot) {
    case 'module_body': return ['assign', 'assign', 'assign', 'function', 'range', 'while', 'print', 'print', 'print', 'finish'][n] ?? 'finish';
    case 'assignment_target': return n < 2 ? 'new' : 'name_0';
    case 'assignment_name': return ['total', 'message', 'result'][n]!;
    case 'value': return ['number', 'string', 'boolean', 'binary'][n]!;
    case 'number': return ['0', '0', '0', '10', '0', '1'][n]!;
    case 'string': return 'hello';
    case 'singleton': return 'true';
    case 'function_name': return 'add';
    case 'parameter_count': return '2';
    case 'parameter_0': return 'a';
    case 'parameter_1': return 'b';
    case 'function_body': return n === 0 ? 'if' : 'finish';
    case 'condition': return 'compare';
    case 'operator': return criteria.includes('gt') ? 'gt' : 'add';
    case 'left': return 'name';
    case 'right': return n === 1 || n === 2 ? 'name' : 'number';
    case 'reference': return ['b', 'b', 'a', 'b', 'total', 'i', 'message', 'result'][n]!;
    case 'if_body': return 'return';
    case 'else_branch': return 'yes';
    case 'else_body': return 'return';
    case 'returned': return n === 0 ? 'name' : 'binary';
    case 'loop_variable': return 'i';
    case 'start': return 'number';
    case 'stop': return 'number';
    case 'loop_body': return n === 0 ? 'assign' : n === 2 ? 'break' : 'finish';
    case 'printed': return n === 0 ? 'call' : 'name';
    case 'callee': return 'add';
    case 'argument_0': return 'name';
    case 'argument_1': return 'number';
    default: return criteria[0]!;
  }
};

const prompt = 'add numbers, print hello, the total and the result.';

const expected = [
  '#include <stdio.h>',
  '#include <stdbool.h>',
  '',
  'long add(long a, long b) {',
  '  if (b > 0L) {',
  '    return b;',
  '  } else {',
  '    return a + b;',
  '  }',
  '}',
  '',
  'int main(void) {',
  '  long total = 0L;',
  '  const char *message = "hello";',
  '  bool result = true;',
  '  for (long i = 0L; i < 10L; i++) {',
  '    total = total + i;',
  '  }',
  '  while (total > 0L) {',
  '    break;',
  '  }',
  '  printf("%ld\\n", add(total, 1L));',
  '  printf("%s\\n", message);',
  '  printf("%s\\n", (result) ? "true" : "false");',
  '  return 0;',
  '}',
  '',
].join('\n');

test('the C dialect renders functions first, typed declarations, and typed printf calls', async () => {
  const previews: string[] = [];
  const dialect: Dialect = { ...cDialect, render: p => { const s = cDialect.render(p); previews.push(s); return s; } };
  const source = await run(dialect, prompt, script);
  assert.equal(source, expected);
  assert.ok(previews.some(p => p.includes('__jev_pending__')));
  assert.ok(previews.some(p => p.includes('  long total = __jev_pending__;')));
  assert.ok(previews.some(p => p.includes('printf("%s\\n", __jev_pending__);')));
});

test('an empty block and a statement hole keep the pending slot visible', () => {
  assert.equal(cDialect.render({ body: [{ kind: 'while', test: { kind: 'bool', value: true }, body: [] }, { kind: 'hole' }] }), [
    '#include <stdbool.h>',
    '',
    'int main(void) {',
    '  while (true) {',
    '    __jev_pending__;',
    '  }',
    '  __jev_pending__;',
    '  return 0;',
    '}',
    '',
  ].join('\n'));
  assert.equal(cDialect.render({ body: [] }), 'int main(void) {\n  return 0;\n}\n');
  assert.equal(cDialect.render({ body: [{ kind: 'print', value: { kind: 'number', value: -1 } }] }), '#include <stdio.h>\n\nint main(void) {\n  printf("%ld\\n", (-1L));\n  return 0;\n}\n');
});

test('the C validator accepts the generated program and rejects a broken one', async t => {
  if (!hasCompiler) { t.skip('neither gcc nor clang is on PATH'); return; }
  await cDialect.validate(expected, new AbortController().signal);
  await assert.rejects(cDialect.validate('int main(void) {\n  long = ;\n  return 0;\n}\n', new AbortController().signal), /C validation failed/);
  await assert.rejects(cDialect.validate('int main(void) {\n  undeclared(1);\n  return 0;\n}\n', new AbortController().signal), /implicit/);
});

test('the adapter exposes the dialect identity', () => {
  assert.equal(cAstAdapter.id, 'c');
  assert.deepEqual(cAstAdapter.extensions, ['.c']);
  assert.deepEqual(cAstAdapter.languages, ['c']);
});

test('a block drops a statement identical to the previous one and finishes after two repeats', async () => {
  const src = await run(typescriptDialect, 'write a program', ({ slot, criteria }) => {
    switch (slot) {
      case 'module_body': return 'assign';
      case 'assignment_target': return criteria.includes('name_0') ? 'name_0' : 'new';
      case 'assignment_name': return 'i';
      case 'value': return 'number';
      case 'number': return '0';
      default: return criteria[0]!;
    }
  });
  assert.equal(src.split('\n').filter(Boolean).length, 2);
});
