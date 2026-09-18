import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { Dialect } from '../src/lang/core.js';
import { luaAstAdapter, luaDialect } from '../src/lang/lua.js';
import { fullScript, run, type Script } from './lang-helpers.js';

const hasLua = ['luac', 'lua'].some(cmd => spawnSync(cmd, ['-v'], { stdio: 'ignore' }).status === 0);
const signal = (): AbortSignal => new AbortController().signal;

const luaScript: Script = ({ slot, criteria }, n) => {
  switch (slot) {
    case 'module_body': return ['assign', 'function', 'foreach', 'print', 'print', 'finish'][n] ?? 'finish';
    case 'assignment_target': return 'new';
    case 'assignment_name': return 'items';
    case 'value': return 'list';
    case 'element_count': return '2';
    case 'element_0': case 'element_1': return 'number';
    case 'number': return ['1', '2', '1', '0', '2'][n] ?? '0';
    case 'function_name': return 'first';
    case 'parameter_count': return '1';
    case 'parameter_0': return 'xs';
    case 'function_body': return n === 0 ? 'foreach' : 'return';
    case 'loop_variable': return 'x';
    case 'iterable': return 'name';
    case 'reference': return ['x', 'items'][n] ?? 'items';
    case 'loop_body': return ['if', 'print', 'finish'][n] ?? 'finish';
    case 'condition': return 'compare';
    case 'operator': return 'ne';
    case 'left': return n === 0 ? 'name' : 'string';
    case 'right': return n === 0 ? 'number' : 'string';
    case 'if_body': return 'continue';
    case 'else_branch': return 'yes';
    case 'else_body': return 'break';
    case 'returned': return n === 0 ? 'name' : 'concat';
    case 'string': return n === 0 ? 'first' : 'none';
    case 'printed': return ['index', 'call', 'concat'][n] ?? 'call';
    case 'object': return 'name';
    case 'index': return 'number';
    case 'callee': return 'first';
    case 'argument_0': return 'number';
    default: return criteria[0]!;
  }
};

test('the Lua dialect renders the shared production set', async () => {
  const source = await run(luaDialect, 'add numbers and print the total.', fullScript);
  assert.equal(source, [
    'local total = 0',
    'local function add(a, b)',
    '  if b > 0 then',
    '    return b',
    '  end',
    '  return b + 0',
    'end',
    'for i = 0, (0) - 1 do',
    '  total = 0',
    '  ::continue_label::',
    'end',
    'while total > 0 do',
    '  break',
    '  ::continue_label::',
    'end',
    'print(add(total, 0))',
    '',
  ].join('\n'));
});

test('the Lua dialect renders lists, 1-based indexing, foreach, continue, else and concat', async t => {
  const previews: string[] = [];
  const dialect: Dialect = { ...luaDialect, render: p => { const s = luaDialect.render(p); previews.push(s); return s; } };
  const source = await run(dialect, 'Return the first item of xs or none.', luaScript);
  assert.equal(source, [
    'local items = {1, 2}',
    'local function first(xs)',
    '  for _, x in ipairs(xs) do',
    '    if x ~= 1 then',
    '      goto continue_label',
    '    else',
    '      break',
    '    end',
    '    ::continue_label::',
    '  end',
    '  return xs',
    'end',
    'for _, x in ipairs(items) do',
    '  print(items[(0) + 1])',
    '  ::continue_label::',
    'end',
    'print(first(2))',
    'print("first" .. "none")',
    '',
  ].join('\n'));
  assert.ok(previews.some(p => p.includes('__jev_pending__')));
  assert.ok(previews.some(p => p.includes('for _, x in ipairs(__jev_pending__) do\n    __jev_pending__\n')));
  if (!hasLua) return t.skip('luac and lua are missing');
  await luaDialect.validate(source, signal());
});

test('the Lua validator accepts the full program and rejects broken source', async t => {
  if (!hasLua) return t.skip('luac and lua are missing');
  const source = await run(luaDialect, 'add numbers and print the total.', fullScript);
  await luaDialect.validate(source, signal());
  await assert.rejects(luaDialect.validate('local = \n', signal()), /Lua validation failed: .*near '='/);
  await assert.rejects(luaAstAdapter.validate('while true do\n  return 1\n  ::continue_label::\nend\n', signal()), /'end' expected/);
});

test('the Lua adapter exposes the dialect identity', () => {
  assert.equal(luaAstAdapter.id, 'lua');
  assert.deepEqual(luaAstAdapter.extensions, ['.lua']);
  assert.deepEqual(luaAstAdapter.languages, ['lua']);
  assert.equal(luaDialect.typed, false);
  assert.ok(luaDialect.keywords.has('end') && luaDialect.keywords.has('ipairs'));
});
