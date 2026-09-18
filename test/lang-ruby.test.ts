import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { Dialect, Program } from '../src/lang/core.js';
import { rubyDialect } from '../src/lang/ruby.js';
import { fullScript, run, type Script } from './lang-helpers.js';

const hasRuby = spawnSync('ruby', ['--version'], { stdio: 'ignore' }).status === 0;
const signal = (): AbortSignal => new AbortController().signal;

const fullSource = [
  'total = 0',
  'def add(a, b)',
  '  if b > 0',
  '    return b',
  '  end',
  '  return b + 0',
  'end',
  '(0...0).each do |i|',
  '  total = 0',
  'end',
  'while total > 0',
  '  break',
  'end',
  'puts add(total, 0)',
  '',
].join('\n');

const listScript: Script = ({ slot, criteria }, n) => {
  switch (slot) {
    case 'module_body': return ['assign', 'print', 'foreach', 'print', 'finish'][n] ?? 'finish';
    case 'assignment_name': return 'items';
    case 'value': return 'list';
    case 'element_count': return '2';
    case 'element_0': case 'element_1': return 'number';
    case 'number': return n === 1 ? '2' : '1';
    case 'printed': return n === 0 ? 'index' : n === 1 ? 'name' : 'concat';
    case 'object': return 'name';
    case 'index': return 'number';
    case 'loop_variable': return 'x';
    case 'iterable': return 'name';
    case 'loop_body': return n === 0 ? 'print' : 'finish';
    case 'reference': return criteria[criteria.length - 1]!;
    case 'left': case 'right': return 'string';
    case 'string': return n === 0 ? 'Print' : 'hello';
    default: return criteria[0]!;
  }
};

const listSource = [
  'items = [1, 2]',
  'puts items[1]',
  'items.each do |x|',
  '  puts x',
  'end',
  'puts "Print" + "hello"',
  '',
].join('\n');

test('the Ruby dialect renders every production', async () => {
  assert.equal(await run(rubyDialect, 'add numbers and print the total.', fullScript), fullSource);
  assert.equal(await run(rubyDialect, 'Print hello.', listScript), listSource);
});

test('the Ruby dialect marks holes while building', async () => {
  const previews: string[] = [];
  const dialect: Dialect = { ...rubyDialect, render: p => { const s = rubyDialect.render(p); previews.push(s); return s; } };
  await run(dialect, 'add numbers and print the total.', fullScript);
  assert.ok(previews.some(p => p.includes('__jev_pending__')));
  const program: Program = { body: [
    { kind: 'if', test: { kind: 'hole' }, body: [], orelse: [] },
    { kind: 'hole' },
    { kind: 'print', value: { kind: 'string', value: '#{x}' } },
    { kind: 'assign', id: 'n', value: { kind: 'number', value: -1 }, declare: true, type: 'number' },
  ] };
  assert.equal(rubyDialect.render(program), 'if __jev_pending__\n  __jev_pending__\nend\n__jev_pending__\nputs "\\#{x}"\nn = (-1)\n');
});

test('ruby -c accepts the rendered programs', async t => {
  if (!hasRuby) { t.skip('ruby is not on PATH'); return; }
  await rubyDialect.validate(fullSource, signal());
  await rubyDialect.validate(listSource, signal());
});

test('ruby -c rejects a broken program', async t => {
  if (!hasRuby) { t.skip('ruby is not on PATH'); return; }
  await assert.rejects(rubyDialect.validate('def add(a, b)\n  if\nend\n', signal()), /syntax/);
});
