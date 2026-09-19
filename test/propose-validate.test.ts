import assert from 'node:assert/strict';
import test from 'node:test';
import { AstRegistry } from '../src/ast-adapters.js';
import type { ProposalRequest } from '../src/providers/types.js';
import { normalize, stripFences, validateCandidates } from '../src/propose/validate.js';

const registry = new AstRegistry();
const signal = new AbortController().signal;
const done = (text: string) => ({ text, truncated: false });
const fileReq = (path: string, current?: string): ProposalRequest =>
  ({ kind: 'file', objective: 'o', constraints: '', count: 3, path, ...(current === undefined ? {} : { current }) });

test('stripFences removes a fenced wrapper and leaves plain text alone', () => {
  assert.equal(stripFences('```py\ndef f():\n  return 1\n```\n'), 'def f():\n  return 1\n');
  assert.equal(stripFences('```\nx = 1\n```'), 'x = 1\n');
  assert.equal(stripFences('def f():\n  return 1\n'), 'def f():\n  return 1\n');
  assert.equal(stripFences('a\n```\nb\n```\n'), 'a\n```\nb\n```\n');
  assert.equal(stripFences('```python\nprint(1)\nprint(2)'), 'print(1)\nprint(2)\n');
  assert.equal(stripFences('```python\nprint(1)\n```\nThis prints one.\n'), 'print(1)\n');
  assert.equal(stripFences('```markdown\n# Doc\n\n```bash\nls\n```\n\nDone.\n```\n'), '# Doc\n\n```bash\nls\n```\n\nDone.\n');
});

test('normalize unifies line endings, trailing whitespace and the final newline', () => {
  assert.equal(normalize('a  \r\nb\t\r\n\r\n'), 'a\nb\n');
  assert.equal(normalize('a\nb'), 'a\nb\n');
  assert.equal(normalize('a\nb\n'), normalize('a\nb\n\n\n'));
});

test('validateCandidates applies every rule for a python file', async () => {
  const cur = 'def f():\n  return 0\n';
  const req = fileReq('x.py', cur);
  const first = await validateCandidates(req, [
    done('def f(:\n'),
    done(cur),
    done(cur + '\n'),
    done(''),
    done('x = 1\n'.repeat(4000)),
  ], registry, signal);
  assert.deepEqual(first.map(c => c.label), ['A', 'B', 'C', 'D', 'E']);
  assert.ok(first.every(c => !c.valid));
  assert.match(first[0]!.reason!, /SyntaxError/);
  assert.deepEqual(first.slice(1).map(c => c.reason), ['unchanged', 'unchanged', 'empty', 'too large']);
  const second = await validateCandidates(req, [
    { text: 'def f():\n  return 1\n', truncated: true },
    { error: 'boom' },
    done('```py\ndef f():\n  return 1\n```\n'),
  ], registry, signal);
  assert.deepEqual(second.map(c => c.label), ['A', 'B', 'C']);
  assert.equal(second[0]!.reason, 'truncated');
  assert.equal(second[1]!.reason, 'generation failed: boom');
  assert.equal(second[1]!.bytes, 0);
  assert.equal(second[2]!.valid, true);
  assert.equal(second[2]!.reason, undefined);
  assert.equal(second[2]!.text, 'def f():\n  return 1\n');
  assert.equal(second[2]!.bytes, 20);
});

test('validateCandidates skips the adapter for paths without one and for text kind', async () => {
  const txt = await validateCandidates(fileReq('x.txt', 'old\n'), [done('def f(:\n'), done('old\n'), { text: 'a', truncated: true }], registry, signal);
  assert.deepEqual(txt.map(c => c.valid), [true, false, false]);
  assert.deepEqual(txt.slice(1).map(c => c.reason), ['unchanged', 'truncated']);
  const text = await validateCandidates({ kind: 'text', objective: 'o', constraints: '', count: 1 }, [done('def f(:\n')], registry, signal);
  assert.equal(text[0]!.valid, true);
});

test('validateCandidates marks later identical candidates as duplicates', async () => {
  const out = await validateCandidates(fileReq('x.txt', 'old\n'), [done('new\n'), done('new  \r\n'), done('other\n')], registry, signal);
  assert.deepEqual(out.map(c => c.valid), [true, false, true]);
  assert.equal(out[1]!.reason, 'duplicate of A');
});
