import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import type { Dialect } from '../src/lang/core.js';
import { goDialect } from '../src/lang/go.js';
import { fullScript, run } from './lang-helpers.js';

const hasGo = (): boolean => {
  try { execFileSync('go', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
};

const expected = [
  'package main',
  '',
  'import "fmt"',
  '',
  'func add(a int, b int) int {',
  '\tif b > 0 {',
  '\t\treturn b',
  '\t}',
  '\treturn b + 0',
  '}',
  '',
  'func main() {',
  '\ttotal := 0',
  '\t_ = total',
  '\tfor i := 0; i < 0; i++ {',
  '\t\t_ = i',
  '\t\ttotal = 0',
  '\t}',
  '\tfor total > 0 {',
  '\t\tbreak',
  '\t}',
  '\tfmt.Println(add(total, 0))',
  '}',
  '',
].join('\n');

test('the Go dialect renders every supported production', async () => {
  const source = await run(goDialect, 'add numbers and print the total.', fullScript);
  assert.equal(source, expected);
});

test('a preview mid-generation marks the pending slot', async () => {
  const previews: string[] = [];
  const dialect: Dialect = { ...goDialect, render: p => { const s = goDialect.render(p); previews.push(s); return s; } };
  await run(dialect, 'add numbers and print the total.', fullScript);
  assert.ok(previews.some(p => p.includes('__jev_pending__')));
  assert.ok(previews.some(p => p.includes('func main() {\n\t__jev_pending__\n}\n')));
});

test('programs without a print statement do not import fmt', async () => {
  const source = await run(goDialect, 'Set x.', ({ slot, criteria }, n) => {
    if (slot === 'module_body') return n === 0 ? 'assign' : 'finish';
    if (slot === 'assignment_name') return 'x';
    if (slot === 'value') return 'boolean';
    if (slot === 'singleton') return 'true';
    return criteria[0]!;
  });
  assert.equal(source, 'package main\n\nfunc main() {\n\tx := true\n\t_ = x\n}\n');
});

test('go vet accepts the generated program', async t => {
  if (!hasGo()) { t.skip('go is not on PATH'); return; }
  await goDialect.validate(expected, new AbortController().signal);
});

test('go vet rejects a broken program', async t => {
  if (!hasGo()) { t.skip('go is not on PATH'); return; }
  await assert.rejects(goDialect.validate('package main\n\nfunc main() {\n\tx := \n}\n', new AbortController().signal), /Go validation failed/);
  await assert.rejects(goDialect.validate('package main\n\nfunc main() {\n\tx := 1\n}\n', new AbortController().signal), /declared and not used/);
});
