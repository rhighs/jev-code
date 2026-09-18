import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Harness } from '../src/harness.js';
import { builtInTools } from '../src/tools.js';
import type { DecisionProvider, Tool } from '../src/types.js';
import { ScriptedProvider, type Step } from './helpers.js';

async function workspace(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'jev-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('default text generation avoids grids, retries retain the objective, and finish uses observed facts', async t => {
  const root = await workspace(t);
  const events: import('../src/types.js').HarnessEvent[] = [];
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'hello.txt', content: 'hello' } },
    { action: 'finish', verdict: 0.79 },
  ]);
  const harness = new Harness({ workspace: root, provider, journalDirectory: false, onEvent: event => { events.push(event); } });
  const first = await harness.run('Write "hello" into hello.txt.');
  assert.equal(first.status, 'completed', first.summary);
  assert.equal(first.summary, 'Wrote hello.txt.');
  assert.equal(first.modelSummary, undefined);
  const second = await harness.run('retry');
  assert.equal(second.status, 'completed', second.summary);
  assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'hello');
  assert.ok(provider.states.every(state => state.task.prompt === 'Write "hello" into hello.txt.'));
  assert.ok(events.filter(event => event.type === 'text').every(event => event.data.decoder !== 'grid' && event.data.field !== 'summary'));
  assert.ok(!provider.states.some(state => state.generation?.phase === 'cells'));
  assert.equal(first.turnTimings.at(-1)?.requests, 2, 'finish only selects the action and checks completion');
});

test('completion checks are scoped to the current task, excluding previous blocked conversations', async t => {
  const root = await workspace(t);
  const base = new ScriptedProvider([{ action: 'finish', verdict: 0.79 }]);
  let seen = false;
  const provider: DecisionProvider = { decide: async (input, questions, signal) => {
    const state = input as unknown as Record<string, unknown>;
    if (state.completionCheck) {
      seen = true;
      assert.equal(state.conversation, undefined);
      assert.equal(state.rules, undefined);
      assert.equal(questions.selection?.type, 'choice');
      assert.equal(questions.verdict, undefined);
    }
    return base.decide(input, questions, signal);
  } };
  const harness = new Harness({ workspace: root, provider, journalDirectory: false });
  assert.equal((await harness.run('No file changes required.')).status, 'completed');
  assert.equal((await harness.run('Only report completion.')).status, 'completed');
  assert.ok(seen);
});

test('unchanged bash, read and plan cycles stop after three rejected completion checks', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'hello.txt', content: 'hello' } },
    { action: 'finish', verdict: 0.1 },
    { action: 'bash', args: { command: 'printf hello', cwd: '.', timeout_ms: '' } },
    { action: 'finish', verdict: 0.1 },
    { action: 'set_plan', args: { plan: 'Verify hello.txt.' } },
    { action: 'finish', verdict: 0.1 },
  ]);
  const result = await new Harness({ workspace: root, provider, experimentalGrid: true, journalDirectory: false }).run('Write hello.txt with hello.');
  assert.equal(result.status, 'limited', result.summary);
  assert.equal(result.turns, 6);
  assert.match(result.summary, /Stopped after 3 rejected completion checks/);
  assert.equal(result.records.filter(record => record.tool === 'bash').length, 1);
});

test('two consecutive writes to the same path without a read or run make write tools unavailable for a turn', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'hello.txt', content: 'hello' } },
    { action: 'write_file', args: { path: 'hello.txt', content: 'hello again' } },
    { action: 'bash', args: { command: 'cat hello.txt', cwd: '.', timeout_ms: '' } },
    { action: 'finish', verdict: 1 },
  ]);
  const result = await new Harness({ workspace: root, provider, experimentalGrid: true, journalDirectory: false }).run('Write hello.txt with hello.');
  assert.equal(result.status, 'completed', result.summary);
  const third = provider.states.find(state => state.task.turn === 3) as { progressFeedback?: string } | undefined;
  assert.match(third?.progressFeedback ?? '', /rewrote hello.txt/);
  assert.ok(!(provider.states.find(state => state.task.turn === 2) as { progressFeedback?: string })?.progressFeedback);
});

test('explicit strict completion thresholds still reject intermediate probabilities and terminate', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([
    { action: 'finish', verdict: 0.79 },
    { action: 'set_plan', args: { plan: 'Verify the result.' } },
    { action: 'finish', verdict: 0.72 },
    { action: 'set_plan', args: { plan: 'Verify the result.' } },
    { action: 'finish', verdict: 0.78 },
  ]);
  const result = await new Harness({ workspace: root, provider, completionThreshold: 0.85, journalDirectory: false }).run('Verify the result.');
  assert.equal(result.status, 'limited', result.summary);
  assert.equal(result.turns, 5);
  assert.equal(provider.states.filter(state => state.completionCheck).length, 3);
});

test('rejected completion cannot immediately repeat and does not contaminate later verification evidence', async t => {
  const root = await workspace(t);
  const base = new ScriptedProvider([
    { action: 'write_file', args: { path: 'hello.txt', content: 'hello' } },
    { action: 'finish', verdict: 0.1 },
    { action: 'read_file', args: { path: 'hello.txt', offset: '', limit: '' } },
    { action: 'finish' },
  ]);
  let checks = 0;
  const provider: DecisionProvider = { decide: async (input, questions, signal) => {
    const state = input as unknown as import('./helpers.js').TestState;
    if (state.task.turn === 3 && !state.generation && !state.field && questions.selection?.type === 'choice') assert.ok(!Object.hasOwn(questions.selection.criteria, 'finish'));
    if (state.completionCheck) { checks++; assert.ok(state.recent.every(record => record.tool !== 'finish')); }
    return base.decide(input, questions, signal);
  } };
  const result = await new Harness({ workspace: root, provider, journalDirectory: false }).run('Write hello.txt with "hello" and verify it.');
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(checks, 2);
  assert.match(result.summary, /Wrote hello.txt/);
});

test('full turn loop writes JS, observes a real failure, edits, verifies, and journals completion', async t => {
  const root = await workspace(t);
  const steps: Step[] = [
    { action: 'write_file', args: { path: 'nested/check.mjs', content: 'if (2 + 2 !== 5) throw new Error("wrong");\n' } },
    { action: 'bash', args: { command: 'node nested/check.mjs', cwd: '.', timeout_ms: '' } },
    { action: 'read_file', args: { path: 'nested/check.mjs', offset: '', limit: '' } },
    { action: 'edit_file', args: { path: 'nested/check.mjs', old_text: '5', new_text: '4' } },
    { action: 'bash', args: { command: 'node nested/check.mjs', cwd: '.', timeout_ms: '' } },
    { action: 'finish', args: { summary: 'Fixed the JavaScript check and verified it with Node.' } },
  ];
  const provider = new ScriptedProvider(steps, state => {
    if (state.task.turn === 3) assert.equal(state.recent.at(-1)?.result.ok, false);
    if (state.task.turn === 6) assert.equal(state.recent.at(-1)?.result.ok, true);
  });
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider }).run('Create and verify a JavaScript arithmetic check.');
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(result.turns, 6);
  assert.deepEqual(result.records.map(record => record.result.ok), [true, false, true, true, true]);
  assert.match(await readFile(join(root, 'nested/check.mjs'), 'utf8'), /!== 4/);
  assert.equal(result.usage.inputTokens, result.requests * 10);
  const log = join(root, '.jev/runs', `${result.id}.jsonl`);
  const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'start');
  assert.equal(events.at(-1).data.status, 'completed');
  assert.equal(events.filter(event => event.type === 'tool_end').length, 5);
  assert.equal((await stat(log)).mode & 0o777, 0o600);
});

test('unfinished generation never writes a partial file', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([{ action: 'write_file', args: { path: 'some-new-file.txt', content: 'unfinished' } }]);
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, maxGenerationSteps: 1, journalDirectory: false }).run('Create a new file.');
  assert.equal(result.status, 'limited');
  assert.deepEqual(await readdir(root), []);
});

test('request budget terminates before any side effect', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([{ action: 'write_file', args: { path: 'abcdef.txt', content: 'x' } }]);
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, maxRequests: 2, journalDirectory: false }).run('Write a file.');
  assert.equal(result.status, 'limited');
  assert.equal(result.requests, 2);
  assert.deepEqual(await readdir(root), []);
});

test('turn exhaustion reports limited, even when the last tool succeeded', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([{ action: 'write_file', args: { path: 'a.txt', content: 'x' } }]);
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, maxTurns: 1, journalDirectory: false }).run('Write a file.');
  assert.equal(result.status, 'limited');
  assert.equal(result.turns, 1);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'x');
});

test('rejected completion becomes next-turn feedback', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([
    { action: 'finish', args: { summary: 'Done.' }, verdict: 0.1 },
    { action: 'blocked', args: { summary: 'A required dependency is unavailable.' } },
  ], state => { if (state.task.turn === 2) assert.match(state.recent.at(-1)!.result.output, /Completion rejected/); });
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, journalDirectory: false }).run('Perform a task.');
  assert.equal(result.status, 'blocked');
  assert.equal(result.records[0]?.tool, 'finish');
});

test('host denial is observed and causes no file mutation', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'a.txt', content: 'x' } },
    { action: 'blocked', args: { summary: 'The host declined the write.' } },
  ]);
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, journalDirectory: false, authorize: () => false }).run('Write a file.');
  assert.equal(result.status, 'blocked');
  assert.match(result.records[0]!.result.output, /declined/);
  assert.deepEqual(await readdir(root), []);
});

test('new user instructions are included at the next turn', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([
    { action: 'set_plan', args: { plan: 'Inspect requirements.' } },
    { action: 'blocked', args: { summary: 'Need the new target environment.' } },
  ], state => {
    if (state.task.turn === 2) assert.deepEqual(state.task.updates, ['Use Rust instead.']);
  });
  const harness = new Harness({ experimentalGrid: true, workspace: root, provider, journalDirectory: false,
    onEvent: event => { if (event.type === 'tool_end') harness.enqueue('Use Rust instead.'); } });
  const result = await harness.run('Create a Python CLI.');
  assert.equal(result.status, 'blocked');
});

test('pre-aborted runs cancel without issuing a model request', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([]);
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, journalDirectory: false }).run('Task.', AbortSignal.abort(new Error('Stop now.')));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.requests, 0);
});

test('time budget aborts in-flight model requests and run overlap is rejected', async t => {
  const root = await workspace(t);
  const provider: DecisionProvider = { decide: (_state, _questions, signal) => new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) };
  const harness = new Harness({ experimentalGrid: true, workspace: root, provider, maxRunMs: 30, journalDirectory: false });
  const pending = harness.run('Slow task.');
  await assert.rejects(harness.run('Overlapping task.'), /one active run/);
  const result = await pending;
  assert.equal(result.status, 'limited');
  assert.match(result.summary, /time budget/);
});

test('API errors during argument generation end the run without retrying a tool', async t => {
  const root = await workspace(t);
  const base = new ScriptedProvider([{ action: 'write_file', args: { path: 'a.txt', content: 'x' } }]);
  let failedRequests = 0;
  const provider: DecisionProvider = { decide: async (state, questions) => {
    if ((state as unknown as { generation?: { field: string } }).generation?.field === 'content') {
      failedRequests++;
      throw new Error('API authentication failed.');
    }
    return base.decide(state, questions);
  } };
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, journalDirectory: false }).run('Write a file.');
  assert.equal(result.status, 'error');
  assert.match(result.summary, /authentication/);
  assert.equal(failedRequests, 1);
  assert.deepEqual(await readdir(root), []);
});

test('instructions arriving during the completion check prevent stale completion', async t => {
  const root = await workspace(t);
  const base = new ScriptedProvider([
    { action: 'finish', args: { summary: 'Done.' } },
    { action: 'blocked', args: { summary: 'Need details for the new requirement.' } },
  ]);
  let harness: Harness;
  const provider: DecisionProvider = { decide: async (state, questions) => {
    if ((state as unknown as { completionCheck?: boolean }).completionCheck) harness.enqueue('Also generate documentation.');
    return base.decide(state, questions);
  } };
  harness = new Harness({ experimentalGrid: true, workspace: root, provider, journalDirectory: false });
  const result = await harness.run('Perform a task.');
  assert.equal(result.status, 'blocked');
  assert.match(result.records[0]!.result.output, /New user instructions/);
  assert.deepEqual(base.states.at(-1)?.task.updates, ['Also generate documentation.']);
});

test('custom tools are selectable and enum/boolean fields are constructed', async t => {
  const root = await workspace(t);
  let observed: Record<string, string | number | boolean> | undefined;
  const base = new ScriptedProvider([{ action: 'custom', args: {} }, { action: 'finish', args: { summary: 'Custom tool ran.' } }]);
  const provider: DecisionProvider = { decide: async (state, questions, signal) => {
    const input = state as unknown as { field?: string };
    if (input.field === 'mode' || input.field === 'flag') {
      const key = input.field === 'mode' ? 'fast' : 'true';
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 }, answers: {
        selection: { type: 'choice', choice: key, confidence: 1, probabilities: { [key]: 1 } },
      } } as never;
    }
    return base.decide(state, questions, signal);
  } };
  const harness = new Harness({ experimentalGrid: true, workspace: root, provider, tools: [{ name: 'custom', effect: 'read', description: 'A custom tool.',
    fields: { mode: { type: 'enum', description: 'Mode.', choices: { fast: 'Fast.', slow: 'Slow.' } }, flag: { type: 'boolean', description: 'Flag.' } },
    async execute(args) { observed = args; return { ok: true, output: 'Custom tool ran.' }; },
  }], journalDirectory: false });
  assert.equal((await harness.run('Run the custom tool.')).status, 'completed');
  assert.deepEqual(observed, { mode: 'fast', flag: true });
});

test('run duration spans prompt processing and is persisted on every outcome', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([{ action: 'blocked', args: { summary: 'Missing requirements.' } }]);
  const events: import('../src/types.js').HarnessEvent[] = [];
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, onEvent: async event => {
    events.push(event);
    if (event.type === 'start') await new Promise(resolve => setTimeout(resolve, 25));
  } }).run('Inspect the requirements.');
  assert.ok(Object.hasOwn(result, 'durationMs'), 'result exposes prompt-to-end duration');
  const timing = result as unknown as { startedAt: string; endedAt: string; durationMs: number };
  assert.ok(timing.durationMs >= 25);
  assert.ok(Date.parse(timing.endedAt) >= Date.parse(timing.startedAt));
  const journal = (await readFile(join(root, '.jev/runs', `${result.id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(journal.at(-1).data.durationMs, timing.durationMs);
  assert.equal(journal.at(-1).data.startedAt, timing.startedAt);
  assert.equal(journal.at(-1).data.endedAt, timing.endedAt);
  assert.ok(journal.every(event => Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0));
  const cancelled = await new Harness({ experimentalGrid: true, workspace: root, provider: new ScriptedProvider([]), journalDirectory: false }).run('Cancel this.', AbortSignal.abort());
  assert.ok(Object.hasOwn(cancelled, 'durationMs'));
});

test('unchanged repeated reads require a different next action', async t => {
  const root = await workspace(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(root, 'main.txt'), 'old');
  const scripted = new ScriptedProvider([
    { action: 'read_file', args: { path: 'main.txt', offset: '', limit: '' } },
    { action: 'read_file', args: { path: 'main.txt', offset: '', limit: '' } },
    { action: 'write_file', args: { path: 'main.txt', content: 'new' } },
    { action: 'finish', args: { summary: 'Updated the file.' } },
  ]);
  const provider: DecisionProvider = { decide: async (input, questions, signal) => {
    const state = input as unknown as { task: { turn: number }; generation?: unknown };
    if (state.task.turn === 3 && !state.generation && questions.selection?.type === 'choice') assert.ok(!Object.hasOwn(questions.selection.criteria, 'read_file'));
    return scripted.decide(input, questions, signal);
  } };
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, journalDirectory: false }).run('Update main.txt.');
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(join(root, 'main.txt'), 'utf8'), 'new');
  assert.equal(result.turnTimings.length, 4);
  assert.equal(result.turnTimings.reduce((sum, timing) => sum + timing.requests, 0), result.requests);
});

test('two consecutive write_files over the same paths trigger the rewrite guard', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([
    { action: 'write_files', args: { set: 'a' } },
    { action: 'write_files', args: { set: 'b' } },
    { action: 'bash', args: { command: 'true', cwd: '.', timeout_ms: '' } },
    { action: 'finish', verdict: 1 },
  ]);
  const tools: Tool[] = [...builtInTools().filter(tool => tool.name !== 'write_files'), {
    name: 'write_files', effect: 'write', description: 'Fake multi-file writer.', fields: { set: { type: 'string', description: 'Set.' } },
    async execute() { return { ok: true, output: 'Wrote 2 files.', data: { paths: ['pkg/mod.py', 'main.py'] } }; },
  }];
  const result = await new Harness({ workspace: root, provider, tools, experimentalGrid: true, journalDirectory: false }).run('Write a package.');
  assert.equal(result.status, 'completed', result.summary);
  const third = provider.states.find(state => state.task.turn === 3) as { progressFeedback?: string } | undefined;
  assert.match(third?.progressFeedback ?? '', /rewrote main\.py, pkg\/mod\.py/);
});
