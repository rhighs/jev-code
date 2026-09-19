import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionStrip, initialState, reduce, type Item, type ToolItem, type TranscriptState } from '../src/transcript.js';
import type { HarnessEvent, HarnessEventData, ToolRecord } from '../src/types.js';

let clock = 0;
const ev = <K extends keyof HarnessEventData>(type: K, data: HarnessEventData[K], turn = 1): HarnessEvent =>
  ({ type, data, runId: 'r', timestamp: 't', elapsedMs: (clock += 10), turn }) as HarnessEvent;
const run = (events: Array<HarnessEvent | Parameters<typeof reduce>[1]>, state = initialState()): TranscriptState => events.reduce(reduce, state);
const start = (): HarnessEvent => ev('start', { schema: 1, prompt: 'Write hello.py', workspace: '/ws', decoder: 'dynamic', limits: { turns: 50, requests: 512 }, journal: null }, 0);
const text = (field: string, value: string, ast?: { slot: string; production: string; unit?: string; candidate?: number }, done = false): HarnessEvent =>
  ev('text', { field, bytes: value.length, done, change: { replace: value }, decoder: ast ? 'ast' : 'choice', step: 1, cursor: { row: 0, column: 0, offset: 0 }, ...(ast ? { ast: { symbols: [], ...ast } } : {}) });
const record = (tool: string, args: ToolRecord['args'], ok: boolean, output: string, data?: Record<string, unknown>, turn = 1): ToolRecord =>
  ({ turn, tool, args, result: { ok, output, ...(data ? { data } : {}) } });
const end = (status: HarnessEventData['end']['status'], summary: string, turn = 1): HarnessEvent =>
  ev('end', { status, summary, modelSummary: null, turns: turn, requests: 4, usage: { inputTokens: 10, outputTokens: 2 }, startedAt: 'a', endedAt: 'b', durationMs: 500 }, turn);
const tools = (state: TranscriptState): ToolItem[] => state.items.filter((i): i is ToolItem => i.kind === 'tool');

test('happy path yields prompt, turn, a write card clipped to 8 lines, and a summary in order', () => {
  const content = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const state = run([
    start(),
    ev('turn', { files: 0, plan: '' }),
    ev('decision', { model: 'm', choice: 'write_file', confidence: 1, options: [{ label: 'write_file', probability: 1 }] }),
    ev('action', { tool: 'write_file' }),
    ev('decision', { model: 'm', choice: 'free', confidence: 1, field: 'content', phase: 'plan' }),
    text('path', 'hello.py', undefined, true),
    text('content', content, undefined, true),
    ev('tool_start', { tool: 'write_file', args: { path: 'hello.py', content } }),
    ev('tool_end', record('write_file', { path: 'hello.py', content }, true, 'Wrote 100 bytes to hello.py.', { path: '/ws/hello.py', bytes: 100 })),
    ev('turn_end', { durationMs: 80, elapsedMs: 90, requests: 2 }),
    end('completed', 'Wrote hello.py.'),
  ]);
  assert.equal(state.schema, 1);
  assert.deepEqual(state.items.map((i: Item) => i.kind), ['prompt', 'turn', 'tool', 'summary']);
  const card = tools(state)[0]!;
  assert.equal(card.status, 'done');
  assert.equal(card.tool, 'write_file');
  assert.equal(card.target, 'hello.py');
  assert.equal(card.requests, 1);
  assert.ok(card.durationMs !== undefined && card.durationMs >= 0);
  assert.equal(card.body?.kind, 'source');
  if (card.body?.kind !== 'source') return;
  assert.equal(card.body.lines.length, 8);
  assert.equal(card.body.lines[0], 'line 1');
  assert.equal(card.body.remaining, 6);
  assert.equal(card.body.hint, '/show hello.py');
  assert.deepEqual(state.files, ['hello.py']);
  assert.equal(state.live, undefined);
  assert.equal(state.requests, 2);
  const summary = state.items.at(-1)!;
  assert.equal(summary.kind, 'summary');
  if (summary.kind !== 'summary') return;
  assert.equal(summary.status, 'completed');
  assert.deepEqual(summary.facts, ['Wrote hello.py.']);
  assert.equal(summary.reason, '');
  assert.equal(summary.requests, 4);
  assert.deepEqual(summary.limits, { turns: 50, requests: 512 });
});

test('edit card holds a hunk with one removed and one added line (AE1)', () => {
  const args = { path: 'main.py', old_text: "print('Correct', None)", new_text: "print('Correct')" };
  const state = run([
    start(), ev('turn', { files: 1, plan: '' }), ev('action', { tool: 'edit_file' }),
    ev('tool_start', { tool: 'edit_file', args }),
    ev('tool_end', record('edit_file', args, true, 'Edited main.py.')),
  ]);
  const card = tools(state)[0]!;
  assert.equal(card.body?.kind, 'diff');
  if (card.body?.kind !== 'diff') return;
  assert.deepEqual(card.body.hunk.map(l => `${l.kind}:${l.text}`), ["remove:print('Correct', None)", "add:print('Correct')"]);
  assert.deepEqual(state.files, ['main.py']);
});

test('propose cards show a diff for files and output for text, and a file proposal counts as a written file', () => {
  const head = 'provider=fake model=tiny\nA valid 20 bytes\nB invalid: syntax\nC valid 20 bytes\nselected C 0.81';
  const file = { kind: 'file', path: 'x.py', objective: 'f returns 2', constraints: '', count: 3 };
  const hunk = [{ kind: 'remove', text: '  return 1' }, { kind: 'add', text: '  return 2' }];
  const state = run([
    start(), ev('turn', { files: 1, plan: '' }), ev('action', { tool: 'propose' }),
    ev('decision', { model: 'm', choice: 'C', confidence: 0.81, options: [{ label: 'C', probability: 0.81 }], field: 'candidate', phase: 'propose', slot: 'select' }),
    ev('tool_start', { tool: 'propose', args: file }),
    ev('tool_end', record('propose', file, true, head, { provider: 'fake', model: 'tiny', kind: 'file', path: 'x.py', selected: 'C', confidence: 0.81, hunk })),
  ]);
  const card = tools(state)[0]!;
  assert.equal(card.target, 'x.py');
  assert.equal(card.requests, 1);
  assert.deepEqual(card.body, { kind: 'diff', path: 'x.py', hunk });
  assert.deepEqual(state.files, ['x.py']);
  const text = { kind: 'text', path: '', objective: 'name it', constraints: '', count: 3 };
  const textState = run([
    start(), ev('action', { tool: 'propose' }), ev('tool_start', { tool: 'propose', args: text }),
    ev('tool_end', record('propose', text, true, `${head}\n\nhello`, { provider: 'fake', model: 'tiny', kind: 'text', selected: 'C', confidence: 0.81 })),
  ]);
  const textCard = tools(textState)[0]!;
  assert.equal(textCard.target, 'text');
  assert.equal(textCard.body?.kind, 'output');
  assert.deepEqual(textState.files, []);
  const rejected = run([start(), ev('action', { tool: 'propose' }), ev('tool_end', record('propose', file, false, `${head.split('\n').slice(0, -1).join('\n')}\nrejected all`))]);
  assert.equal(tools(rejected)[0]!.body?.kind, 'output');
  assert.deepEqual(rejected.files, []);
});

test('a close decision is marked low confidence and the ring keeps its options (AE2)', () => {
  const state = run([
    start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'write_file' }),
    text('content', 'def __jev_pending__', { slot: 'module_body', production: 'FunctionDef' }),
    ev('decision', { model: 'm', choice: 'Expr', confidence: 0.9, field: 'content', phase: 'ast', slot: 'stmt', options: [{ label: 'Expr', probability: 0.41 }, { label: 'Assign', probability: 0.39 }, { label: 'Return', probability: 0.2 }] }),
  ]);
  const d = state.live?.decision;
  assert.ok(d);
  assert.equal(d.choice, 'Expr');
  assert.equal(d.lowConfidence, true);
  assert.equal(state.decisions.length, 1);
  assert.deepEqual(state.decisions[0]!.options.map(o => `${o.label}=${o.probability}`), ['Expr=0.41', 'Assign=0.39', 'Return=0.2']);
  assert.match(decisionStrip(state), /stmt → Expr · 41%/);
  assert.match(decisionStrip(state), /low confidence/);
  const confident = reduce(state, ev('decision', { model: 'm', choice: 'Name', confidence: 0.95, field: 'content', slot: 'expr', options: [{ label: 'Name', probability: 0.7 }, { label: 'Call', probability: 0.3 }] }));
  assert.equal(confident.live?.decision?.lowConfidence, false);
  const unsure = reduce(state, ev('decision', { model: 'm', choice: 'Name', confidence: 0.4, field: 'content', slot: 'expr', options: [{ label: 'Name', probability: 0.7 }, { label: 'Call', probability: 0.3 }] }));
  assert.equal(unsure.live?.decision?.lowConfidence, true);
});

test('the decision ring holds the last 20 decisions', () => {
  let state = run([start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'write_file' })]);
  for (let i = 0; i < 25; i++) state = reduce(state, ev('decision', { model: 'm', choice: `c${i}`, confidence: 1, options: [{ label: `c${i}`, probability: 1 }] }));
  assert.equal(state.decisions.length, 20);
  assert.equal(state.decisions[0]!.choice, 'c5');
  assert.equal(state.decisions.at(-1)!.choice, 'c24');
  assert.equal(state.requests, 25);
});

test('write_files card lists every path and the files set includes them', () => {
  const paths = ['main.py', 'pkg/__init__.py', 'pkg/mod.py'];
  const state = run([
    start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'write_files' }),
    ev('tool_start', { tool: 'write_files', args: { files: '{}' } }),
    ev('tool_end', record('write_files', { files: '{}' }, true, 'Wrote 3 files.', { paths, bytes: 30 })),
  ]);
  const card = tools(state)[0]!;
  assert.equal(card.body?.kind, 'paths');
  if (card.body?.kind !== 'paths') return;
  assert.deepEqual(card.body.paths, paths);
  assert.equal(card.body.remaining, 0);
  assert.equal(card.target, '3 files');
  assert.deepEqual(state.files, paths);
});

test('run card holds the exit code and the first 6 output lines', () => {
  const output = Array.from({ length: 9 }, (_, i) => `out ${i}`).join('\n');
  const args = { command: 'ls', cwd: '.', timeout_ms: 1000 };
  const state = run([
    start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'bash' }),
    ev('tool_start', { tool: 'bash', args }),
    ev('tool_output', { stream: 'stdout', text: output.slice(0, 20) }),
    ev('tool_output', { stream: 'stdout', text: output.slice(20) }),
    ev('tool_end', record('bash', args, false, output, { exitCode: 2 })),
  ]);
  const card = tools(state)[0]!;
  assert.equal(card.status, 'failed');
  assert.equal(card.target, 'ls');
  assert.equal(card.exitCode, 2);
  assert.equal(card.body?.kind, 'output');
  if (card.body?.kind !== 'output') return;
  assert.deepEqual(card.body.lines, ['out 0', 'out 1', 'out 2', 'out 3', 'out 4', 'out 5']);
  assert.equal(card.body.remaining, 3);
});

test('non-completed statuses produce a summary item with the status and reason', () => {
  for (const [status, reason] of [['limited', 'Request budget exhausted (512).'], ['cancelled', 'Cancelled by the operator.'], ['error', 'Jev returned invalid usage metadata.']] as const) {
    const state = run([start(), ev('turn', { files: 0, plan: '' }), end(status, reason)]);
    const item = state.items.at(-1)!;
    assert.equal(item.kind, 'summary');
    if (item.kind !== 'summary') continue;
    assert.equal(item.status, status);
    assert.equal(item.reason, reason);
    assert.deepEqual(item.facts, []);
  }
  const rejected = run([start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'write_file' }),
    ev('tool_end', record('write_file', { path: 'a.txt', content: 'x' }, true, 'Wrote 1 bytes to a.txt.')),
    end('limited', 'Wrote a.txt.\nStopped after 3 rejected completion checks without an implementation change.')]);
  const item = rejected.items.at(-1)!;
  if (item.kind !== 'summary') { assert.fail('expected summary'); }
  assert.deepEqual(item.facts, ['Wrote a.txt.']);
  assert.match(item.reason, /^Stopped after 3 rejected/);
});

test('a rejected finish yields a failed card with the rejection text and the end event produces a summary, not a card', () => {
  const rejection = 'Completion rejected (1/3): the completion check selected continue.';
  const state = run([
    start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'finish' }),
    ev('tool_end', record('finish', {}, false, rejection)),
    ev('turn', { files: 0, plan: '' }, 2), ev('action', { tool: 'finish' }),
    end('completed', 'Jev reported completion; no external tool actions were performed.', 2),
  ]);
  assert.deepEqual(state.items.map(i => i.kind), ['prompt', 'turn', 'tool', 'turn', 'summary']);
  const card = tools(state)[0]!;
  assert.equal(card.tool, 'finish');
  assert.equal(card.status, 'failed');
  assert.deepEqual(card.body, { kind: 'output', lines: [rejection], remaining: 0 });
  assert.equal(state.live, undefined);
});

test('permission requests move the card to awaiting and a denial is recorded as a denied card', () => {
  const args = { command: 'rm -rf build', cwd: '.', timeout_ms: 1000 };
  const awaiting = run([start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'bash' }), { type: 'permission', data: { tool: 'bash', args } }]);
  assert.equal(awaiting.live?.card.status, 'awaiting');
  assert.equal(awaiting.live?.card.target, 'rm -rf build');
  const denied = run([{ type: 'permission_result', data: { tool: 'bash', allowed: false } },
    ev('tool_end', record('bash', args, false, 'Host declined this tool call. Choose another action or explain the blocker.'))], awaiting);
  assert.equal(tools(denied)[0]!.status, 'denied');
  const allowed = run([{ type: 'permission_result', data: { tool: 'bash', allowed: true } }, ev('tool_start', { tool: 'bash', args }),
    ev('tool_end', record('bash', args, true, 'ok', { exitCode: 0 }))], awaiting);
  assert.equal(tools(allowed)[0]!.status, 'done');
  const interrupted = run([ev('tool_end', record('bash', args, false, 'New user instructions arrived before execution. Reconsider this action using the updated task.'))], awaiting);
  assert.equal(tools(interrupted)[0]!.status, 'failed');
});

test('interleaved unit decisions pair with their own slots and batched decisions only count requests', () => {
  const base = run([start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'write_file' })]);
  assert.equal(decisionStrip(base), 'choosing…');
  const a = reduce(base, ev('decision', { model: 'm', choice: 'Return', confidence: 1, field: 'content', slot: 'stmt', unit: 'area', options: [{ label: 'Return', probability: 0.8 }, { label: 'Expr', probability: 0.2 }] }));
  const a2 = reduce(a, text('content', 'def area(): __jev_pending__', { slot: 'stmt', production: 'Return', unit: 'area' }));
  assert.equal(a2.live?.decision?.unit, 'area');
  const b = reduce(a2, ev('decision', { model: 'm', choice: 'Expr', confidence: 1, field: 'content', slot: 'stmt', unit: 'main', options: [{ label: 'Expr', probability: 0.9 }, { label: 'Return', probability: 0.1 }] }));
  assert.equal(b.live?.decision?.unit, 'area', 'a decision for another unit does not replace the strip');
  const b2 = reduce(b, text('content', 'def main(): __jev_pending__', { slot: 'stmt', production: 'Expr', unit: 'main' }));
  assert.equal(b2.live?.decision?.unit, 'main');
  assert.equal(b2.live?.decision?.choice, 'Expr');
  const batched = reduce(b2, ev('decision', { model: 'm', questions: 6 }));
  assert.deepEqual(batched.live?.decision, b2.live?.decision);
  assert.equal(batched.requests, b2.requests + 1);
  assert.equal(batched.decisions.length, 2);
  const single = reduce(batched, text('content', 'def main(): x = __jev_pending__', { slot: 'name', production: 'x', unit: 'main' }));
  assert.equal(single.live?.decision?.choice, 'x');
  assert.equal(single.live?.decision?.confidence, undefined);
  assert.match(decisionStrip(single), /^name → x · /);
  assert.equal(single.live?.decision?.lowConfidence, false);
});

test('text events update the live path, source, and slot, and tool_end clears the live area', () => {
  const source = 'def main():\n    __jev_pending__\n';
  const state = run([start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'write_file' }),
    text('path', 'app.py', undefined, true),
    text('content', source, { slot: 'body', production: 'Expr' })]);
  assert.equal(state.live?.card.status, 'generating');
  assert.equal(state.live?.path, 'app.py');
  assert.equal(state.live?.source, source);
  assert.equal(state.live?.slot, 'body');
  const done = run([ev('tool_start', { tool: 'write_file', args: { path: 'app.py', content: 'def main():\n    pass\n' } }),
    ev('tool_end', record('write_file', { path: 'app.py', content: 'def main():\n    pass\n' }, true, 'Wrote 22 bytes to app.py.'))], state);
  assert.equal(done.live, undefined);
  assert.equal(tools(done).length, 1);
});

test('input events become update rows and host commands become run cards', () => {
  const state = run([start(), ev('turn', { files: 0, plan: '' }), ev('input', { instruction: 'Also add tests.' }),
    { type: 'host_command', data: { command: 'ls' } },
    ev('tool_output', { stream: 'stdout', text: 'a\nb\n' }),
    ev('tool_end', record('bash', { command: 'ls' }, true, 'a\nb\n', { exitCode: 0 }))]);
  assert.deepEqual(state.items.map(i => i.kind), ['prompt', 'turn', 'update', 'tool']);
  const card = tools(state)[0]!;
  assert.equal(card.host, true);
  assert.equal(card.status, 'done');
  assert.deepEqual(card.body, { kind: 'output', lines: ['a', 'b'], remaining: 0 });
});

test('a root-level step after a unit clears the stale unit and candidate, so pairing and labels stay right', () => {
  const state = run([start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'write_file' }),
    text('content', 'def area():\n    __jev_pending__\n', { slot: 'function_body', production: 'return', unit: 'area', candidate: 1 }),
    text('content', 'def area():\n    return 1\n__jev_pending__\n', { slot: 'module_body', production: 'Expr' }),
    ev('decision', { model: 'm', choice: 'Expr', confidence: 0.9, field: 'content', slot: 'module_body', options: [{ label: 'Expr', probability: 0.9 }, { label: 'Assign', probability: 0.1 }] }),
  ]);
  assert.equal(state.live?.unit, undefined);
  assert.equal(state.live?.candidate, undefined);
  assert.equal(state.live?.decision?.choice, 'Expr');
  assert.deepEqual(state.live?.decision?.options.length, 2);
});

test('grid changes fold into the live source with unknown cells marked, and the strip shows the round progress', () => {
  const grid = (round: number, completed: number, cells: Array<{ index: number; value: string }>): HarnessEvent =>
    ev('text', { field: 'content', bytes: 0, done: false, decoder: 'grid', step: round, cursor: { row: 0, column: 0, offset: 0 },
      change: { grid: { rows: 2, columns: 3, round, completed, total: 6, cells: cells.map(c => ({ ...c, row: Math.floor(c.index / 3), column: c.index % 3, score: 1, probabilities: {} })) } } });
  const state = run([start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'write_file' }), grid(1, 2, [{ index: 0, value: 'x' }, { index: 4, value: '=' }]), grid(1, 3, [{ index: 1, value: ' ' }])]);
  assert.equal(state.live?.source, 'x ·\n·=·');
  assert.equal(decisionStrip(state), 'grid · round 1 · 3/6 cells · 0 req');
  const next = run([grid(2, 1, [{ index: 5, value: '1' }])], state);
  assert.equal(next.live?.source, '···\n··1');
});

test('unknown event types leave the state untouched', () => {
  const state = run([start()]);
  assert.deepEqual(run([{ ...ev('turn', { files: 0, plan: '' }), type: 'future' } as unknown as HarnessEvent], state).items, state.items);
});

test('a pending multi-file write shows no count, and an awaiting multi-line bash lists every command line', () => {
  const state = run([start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'write_files' })]);
  assert.equal(state.live?.card.target, '');
  const awaiting = run([start(), ev('turn', { files: 0, plan: '' }), ev('action', { tool: 'bash' }), { type: 'permission', data: { tool: 'bash', args: { command: 'echo one\necho two\necho three' } } }]);
  assert.equal(awaiting.live?.card.target, 'echo one …');
  assert.deepEqual(awaiting.live?.card.body, { kind: 'output', lines: ['echo one', 'echo two', 'echo three'], remaining: 0 });
});
