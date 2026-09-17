import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { GenerationDisplay } from '../src/draft.js';
import { gridCursor } from '../src/grid.js';
import { terminalColor } from '../src/terminal-style.js';

const metadata = { runId: 'test', timestamp: '2026-09-17T00:00:00Z', elapsedMs: 1, turn: 1 };
test('file previews show destination, numbered actual source and bounded styled lines', () => {
  const display = new GenerationDisplay();
  display.consume({ ...metadata, type: 'action', data: { tool: 'write_file' } });
  display.consume({ ...metadata, type: 'text', data: { field: 'path', decoder: 'choice', step: 1, bytes: 8, done: true, change: { replace: 'hello.py' }, cursor: gridCursor('hello.py') } });
  const source = 'message = "Hello 🌍"\nprint(message)\n';
  display.consume({ ...metadata, type: 'text', data: { field: 'content', decoder: 'ast', step: 4, bytes: Buffer.byteLength(source), done: false,
    change: { replace: source }, cursor: gridCursor(source), ast: { slot: 'module_body', production: 'expr', symbols: ['message'] } } });
  const lines = display.lines(48, 8, true);
  const plain = lines.map(stripVTControlCharacters).join('\n');
  assert.match(plain, /hello.py · building/);
  assert.match(plain, /1  message = "Hello 🌍"/);
  assert.match(plain, /2  print\(message\)/);
  assert.match(plain, /AST step 4/);
  assert.ok(lines.some(line => line.includes('\x1b[32m')));
  assert.ok(display.lines(20, 2).every(line => stripVTControlCharacters(line).length <= 20));
});
test('non-terminal style never enables ANSI colors', () => { assert.equal(terminalColor(false), false); });
