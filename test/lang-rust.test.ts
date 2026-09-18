import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { Dialect } from '../src/lang/core.js';
import { rustDialect } from '../src/lang/rust.js';
import { fullScript, run } from './lang-helpers.js';

const hasRustc = spawnSync('rustc', ['--version'], { stdio: 'ignore' }).status === 0;

const expected = [
  'fn add(a: i64, b: i64) -> i64 {',
  '  if b > 0 {',
  '    return b;',
  '  }',
  '  return b + 0;',
  '}',
  'fn main() {',
  '  let mut total: i64 = 0;',
  '  for i in 0..0 {',
  '    total = 0;',
  '  }',
  '  while total > 0 {',
  '    break;',
  '  }',
  '  println!("{}", add(total, 0));',
  '}',
  '',
].join('\n');

test('the Rust dialect hoists functions above main and types every declaration', async () => {
  const source = await run(rustDialect, 'add numbers and print the total.', fullScript);
  assert.equal(source, expected);
});

test('a preview mid-generation marks the pending slot', async () => {
  const previews: string[] = [];
  const dialect: Dialect = { ...rustDialect, render: p => { const s = rustDialect.render(p); previews.push(s); return s; } };
  await run(dialect, 'add numbers and print the total.', fullScript);
  assert.ok(previews.some(p => p.includes('__jev_pending__')));
  assert.equal(rustDialect.render({ body: [] }), 'fn main() {\n  __jev_pending__;\n}\n');
});

test('rustc accepts the rendered program', async t => {
  if (!hasRustc) { t.skip('rustc missing'); return; }
  await rustDialect.validate(expected, new AbortController().signal);
});

test('rustc rejects a broken program', async t => {
  if (!hasRustc) { t.skip('rustc missing'); return; }
  await assert.rejects(rustDialect.validate('fn main() {\n  let = ;\n}\n', new AbortController().signal), /Rust validation failed/);
});
