import assert from 'node:assert/strict';
import test from 'node:test';
import { diffLines, formatHunk } from '../src/diff.js';

test('one changed line yields one removed and one added line with at most 2 context lines each side', () => {
  const before = 'a\nb\nc\nd\nprint(\'Correct\', None)\ne\nf\ng\nh\n';
  const after = 'a\nb\nc\nd\nprint(\'Correct\')\ne\nf\ng\nh\n';
  const hunk = diffLines(before, after);
  assert.deepEqual(hunk.filter(l => l.kind === 'remove').map(l => l.text), ["print('Correct', None)"]);
  assert.deepEqual(hunk.filter(l => l.kind === 'add').map(l => l.text), ["print('Correct')"]);
  assert.deepEqual(hunk.map(l => l.kind), ['context', 'context', 'remove', 'add', 'context', 'context']);
  assert.deepEqual(formatHunk(hunk), [' c', ' d', "-print('Correct', None)", "+print('Correct')", ' e', ' f']);
});

test('identical texts yield an empty hunk', () => {
  assert.deepEqual(diffLines('x\ny\n', 'x\ny\n'), []);
  assert.deepEqual(diffLines('', ''), []);
});

test('all lines changed yields all removals then all additions', () => {
  assert.deepEqual(diffLines('a\nb', 'c\nd').map(l => `${l.kind}:${l.text}`), ['remove:a', 'remove:b', 'add:c', 'add:d']);
});

test('trailing newline differences do not produce phantom lines', () => {
  assert.deepEqual(diffLines('a\nb', 'a\nb\n'), []);
  assert.deepEqual(diffLines('a\n', 'b').map(l => `${l.kind}:${l.text}`), ['remove:a', 'add:b']);
});

test('changes far apart keep 2 context lines around each and mark the skipped span', () => {
  const before = ['x', '1', '2', '3', '4', '5', '6', '7', 'y'].join('\n');
  const after = ['X', '1', '2', '3', '4', '5', '6', '7', 'Y'].join('\n');
  const kinds = diffLines(before, after).map(l => l.kind);
  assert.deepEqual(kinds, ['remove', 'add', 'context', 'context', 'skip', 'context', 'context', 'remove', 'add']);
  assert.equal(diffLines(before, after).find(l => l.kind === 'skip')?.text, '3 unchanged lines');
});
