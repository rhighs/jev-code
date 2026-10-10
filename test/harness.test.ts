import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import type { AstAdapter } from '../src/ast-adapters.js';
import { MAX_DECISION_REQUEST_BYTES } from '../src/decision-context.js';
import { Harness } from '../src/harness.js';
import { prepareResume } from '../src/replay.js';
import { attemptScope, createRunContext, type RunContext } from '../src/run-context.js';
import { builtInTools } from '../src/tools.js';
import type { DecisionProvider, Tool } from '../src/types.js';
import { ScriptedProvider, SlotProvider, type SlotEntry, type Step } from './helpers.js';

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
  assert.match(third?.progressFeedback ?? '', /rewrote hello.txt without running it/);
  assert.deepEqual(provider.actions.find(a => a.turn === 3)?.offered.sort(), ['bash', 'blocked', 'finish']);
  assert.ok(provider.actions.find(a => a.turn === 4)?.offered.includes('write_file'));
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
  const result = await new Harness({ bundledAsts: false, experimentalGrid: true, workspace: root, provider }).run('Create and verify a JavaScript arithmetic check.');
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
  const provider = new ScriptedProvider([{ action: 'write_file', args: { path: 'some-new-file.txt', content: 'unfinished' } }, { action: 'finish', verdict: 1 }]);
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, maxGenerationSteps: 1, journalDirectory: false }).run('Create a new file.');
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(result.records[0]?.result.ok, false);
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
  const order: string[] = [];
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'a.txt', content: 'x' } },
    { action: 'blocked', args: { summary: 'The host declined the write.' } },
  ]);
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, journalDirectory: false,
    onEvent: event => { if (event.type === 'decision' || event.type === 'action') order.push(event.type); },
    authorize: () => { order.push('authorize'); return false; },
  }).run('Write a file.');
  assert.equal(result.status, 'blocked');
  assert.match(result.records[0]!.result.output, /declined/);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(order.slice(0, 3), ['decision', 'action', 'decision']);
  assert.ok(order.indexOf('authorize') > order.indexOf('action'));
  assert.equal(result.requests, provider.states.length);
});

test('malformed or unavailable action routes fail before authorization or effects', async t => {
  for (const answer of [
    { type: 'choice', choice: 'missing', confidence: 1, probabilities: { write_file: 1 } },
    { type: 'choice', choice: 'write_file', confidence: 1, probabilities: { write_file: 1 }, extra: true },
  ]) {
    const root = await workspace(t);
    let authorizations = 0;
    let executions = 0;
    const provider: DecisionProvider = { decide: async () => ({
      model: 'invalid-route', usage: { input_tokens: 0, output_tokens: 0 }, answers: { selection: answer },
    }) as never };
    const tool: Tool = {
      name: 'write_file', effect: 'write', description: 'Write a file.', fields: {},
      async execute() { executions++; return { ok: true, output: 'unexpected' }; },
    };
    const result = await new Harness({
      workspace: root, provider, tools: [tool], journalDirectory: false,
      authorize: () => { authorizations++; return true; },
    }).run('Write a file.');

    assert.equal(result.status, 'error');
    assert.equal(authorizations, 0);
    assert.equal(executions, 0);
    assert.deepEqual(await readdir(root), []);
  }
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
  const asked: string[][] = [];
  const provider: DecisionProvider = { decide: async (state, questions, signal) => {
    const entries = Object.entries(questions) as Array<[string, { type: string; criteria?: Record<string, string> }]>;
    const choiceFields = entries.filter(([key, question]) => (key === 'mode' || key === 'flag') && question.type === 'choice');
    if (choiceFields.length) {
      asked.push(Object.keys(questions));
      const answers = Object.fromEntries(choiceFields.map(([key, question]) => {
        const selected = key === 'mode' ? 'fast' : 'true';
        return [key, { type: 'choice', choice: selected, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria ?? {}).map(label => [label, label === selected ? 1 : 0])) }];
      }));
      return { model: 'test', usage: { input_tokens: 0, output_tokens: 0 }, answers } as never;
    }
    return base.decide(state, questions, signal);
  } };
  const harness = new Harness({ experimentalGrid: true, workspace: root, provider, tools: [{ name: 'custom', effect: 'read', description: 'A custom tool.',
    fields: { mode: { type: 'enum', description: 'Mode.', choices: { fast: 'Fast.', slow: 'Slow.' } }, flag: { type: 'boolean', description: 'Flag.' } },
    async execute(args) { observed = args; return { ok: true, output: 'Custom tool ran.' }; },
  }], journalDirectory: false });
  assert.equal((await harness.run('Run the custom tool.')).status, 'completed');
  assert.deepEqual(observed, { mode: 'fast', flag: true });
  assert.deepEqual(asked, [['mode', 'flag']], 'both choice-shaped fields are answered by one wave request');
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

test('an identical call that failed twice removes its tool until another action is taken', async t => {
  const root = await workspace(t);
  const scripted = new ScriptedProvider([
    { action: 'read_file', args: { path: 'missing.py', offset: '', limit: '' } },
    { action: 'list_files', args: { path: '.' } },
    { action: 'read_file', args: { path: 'missing.py', offset: '', limit: '' } },
    { action: 'finish', args: { summary: 'missing.py does not exist.' } },
  ]);
  const feedback: string[] = [];
  const provider: DecisionProvider = { decide: async (input, questions, signal) => {
    const state = input as unknown as { task: { turn: number }; generation?: unknown; progressFeedback?: string };
    if (state.task.turn === 4 && !state.generation && questions.selection?.type === 'choice' && Object.hasOwn(questions.selection.criteria, 'finish')) {
      assert.ok(!Object.hasOwn(questions.selection.criteria, 'read_file'));
      assert.ok(Object.hasOwn(questions.selection.criteria, 'list_files'));
      if (state.progressFeedback) feedback.push(state.progressFeedback);
    }
    return scripted.decide(input, questions, signal);
  } };
  const result = await new Harness({ experimentalGrid: true, workspace: root, provider, journalDirectory: false }).run('What is in missing.py?');
  assert.equal(result.status, 'completed');
  assert.match(feedback[0] ?? '', /read_file .*failed 2 times/);
});

test('sequential runs create isolated run contexts that are disposed at run end', async t => {
  const root = await workspace(t);
  const contexts: RunContext[] = [];
  const beforePaths: number[] = [];
  const beforeUnits: number[] = [];
  const scope = attemptScope('content');
  const scripted = new ScriptedProvider([
    { action: 'write_file', args: { path: 'probe.txt', content: 'probe' } },
    { action: 'finish', verdict: 1 },
  ]);
  const provider: DecisionProvider = {
    decide: async (input, questions, signal) => {
      if ((input as { probe?: unknown }).probe === true) {
        return { model: 'probe', usage: { input_tokens: 1, output_tokens: 0 }, answers: {
          selection: { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } },
        } } as never;
      }
      return scripted.decide(input, questions, signal);
    },
  };
  const adapter: AstAdapter = {
    id: 'probe', extensions: ['.txt'], languages: ['text'],
    async generate(decisions) {
      const context = decisions.runContext;
      assert.equal(context.isDisposed, false, 'the run context is live while generating');
      contexts.push(context);
      beforePaths.push(context.pathFor(scope).length);
      beforeUnits.push(context.units.size);
      context.units.set('probe', contexts.length);
      await decisions.chooseWithAlternatives({ probe: true }, 'Pick a probe.',
        { a: 'A', b: 'B' }, { scope, questionKey: 'probe', kind: 'leaf' });
      assert.equal(context.pathFor(scope).length, 1);
      return 'probe\n';
    },
    async validate() {},
  };
  const harness = new Harness({ workspace: root, provider, astAdapters: [adapter], journalDirectory: false });
  const first = await harness.run('Create a probe.txt file containing probe text.');
  assert.equal(first.status, 'completed', first.summary);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]!.isDisposed, true, 'the first run disposes its context before resolving');
  assert.equal(await readFile(join(root, 'probe.txt'), 'utf8'), 'probe\n');

  const second = await harness.run('Create a probe.txt file containing probe text.');
  assert.equal(second.status, 'completed', second.summary);
  assert.equal(contexts.length, 2);
  assert.notEqual(contexts[0], contexts[1]);
  assert.equal(contexts[1]!.isDisposed, true);
  assert.deepEqual(beforePaths, [0, 0], 'a new run starts with an empty decision-path store');
  assert.deepEqual(beforeUnits, [0, 0], 'a new run starts with an empty unit cache');
});

test('disposing a run context shuts its worker down and rejects later use', async () => {
  const context = createRunContext();
  let stopped = 0;
  context.setWorker({ dispose: () => { stopped++; } });
  const decisionId = context.allocateDecisionId();
  context.recordDecision('scope', { decisionId, questionKey: 'slot', identity: {}, chosen: 'a', alternatives: [], nearTie: false, kind: 'leaf' });
  context.recordLine('main.py', 3, { slot: 'module_body', decisionId });
  assert.equal(context.pathFor('scope').length, 1);
  assert.deepEqual(context.slotAtLine('main.py', 3), { slot: 'module_body', decisionId });
  assert.equal(context.decisionEntry(decisionId)?.questionKey, 'slot');
  await context.dispose();
  assert.equal(stopped, 1);
  assert.equal(context.isDisposed, true);
  await context.dispose();
  assert.equal(stopped, 1, 'disposal is idempotent');
  assert.throws(() => context.allocateDecisionId(), /disposed/);
  assert.throws(() => context.recordDecision('scope', { decisionId, questionKey: 'slot', identity: {}, chosen: 'a', alternatives: [], nearTie: false, kind: 'leaf' }), /disposed/);
  assert.throws(() => context.pathFor('scope'), /disposed/);
  assert.throws(() => context.slotAtLine('main.py', 3), /disposed/);
  assert.throws(() => context.setWorker({ dispose() {} }), /disposed/);
});

/** Scripts actions and non-AST fields; Python generation is delegated to a SlotProvider. */
class RepairProvider implements DecisionProvider {
  readonly astStates: Array<{ slot: string; unit?: string }> = [];
  constructor(private readonly slot: SlotProvider, private readonly actions: string[]) {}
  async decide<Q extends Questions>(input: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    const state = input as unknown as { task: { turn: number }; generation?: { slot?: string; unit?: string }; completionCheck?: boolean; field?: string };
    if (state.generation !== undefined) {
      this.astStates.push({ slot: state.generation.slot ?? '', ...(state.generation.unit === undefined ? {} : { unit: state.generation.unit }) });
      return this.slot.decide(input, questions, signal);
    }
    const question = (questions as Record<string, { type: string; criteria: Record<string, string> }>).selection;
    if (question === undefined || question.type !== 'choice') throw new Error('RepairProvider: unexpected question');
    const selected = state.completionCheck ? 'complete' : state.field !== undefined ? (state.field === 'timeout_ms' ? 'default' : 'plan_0') : this.actions[state.task.turn - 1]!;
    return { model: 'repair-test', usage: { input_tokens: 1, output_tokens: 0 }, answers: {
      selection: { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, label === selected ? 1 : 0])) },
    } } as unknown as SystemOneResult<Q>;
  }
}

const planEntries = (): SlotEntry[] => [{ phase: 'plan', answer: 'plan_0', once: true }, { phase: 'plan', answer: 'plan_0', once: true }, { phase: 'plan', answer: 'plan_0', once: true }];
const journalOf = async (root: string, id: string): Promise<Array<{ type: string; data: Record<string, unknown> }>> =>
  (await readFile(join(root, '.jev', 'runs', `${id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; data: Record<string, unknown> });

test('a failing Python run is attributed to its leaf, replayed in place, and re-run in the same turn', async t => {
  const root = await workspace(t);
  const prompt = "Write a Python program in main.py with a helper compute that prints int('5'); do not print int('x').";
  const script: SlotEntry[] = [
    ...planEntries(),
    { slot: 'unit_count', answer: '1' },
    { slot: 'unit_0_name', answer: { value: 'compute' } }, { slot: 'unit_0_arity', answer: '0' }, { slot: 'unit_0_purpose', answer: { value: 'compute' } },
    { unit: 'compute', slot: 'function_body', answer: 'return' }, { unit: 'compute', slot: 'expression', answer: 'call' },
    { unit: 'compute', slot: 'callee', answer: { value: 'int' } }, { unit: 'compute', slot: 'argument_count', answer: '1' },
    { unit: 'compute', slot: 'argument_0', answer: 'string' }, { unit: 'compute', slot: 'string', answer: { value: 'x' } },
    { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' }, once: true },
    { slot: 'argument_count', answer: '1' }, { slot: 'argument_0', answer: 'call', once: true }, { slot: 'callee', answer: { value: 'compute' } },
    { slot: 'module_body', answer: 'finish' },
  ];
  const provider = new RepairProvider(new SlotProvider(script), ['write_file', 'bash', 'finish']);
  const result = await new Harness({ workspace: root, provider, experimentalGrid: true }).run(prompt);

  assert.equal(result.status, 'completed', result.summary);
  const bash = result.records.find(record => record.tool === 'bash')!;
  assert.equal(bash.result.ok, true, bash.result.output);
  assert.match(bash.result.output, /^5$/m, 'the repaired program prints the runner-up literal');
  assert.ok((await readFile(join(root, 'main.py'), 'utf8')).includes("return int('5')"));
  assert.equal(provider.astStates.filter(state => state.unit === 'compute').length, 6, 'the replay asked no unit questions');

  const repairs = (await journalOf(root, result.id)).filter(event => event.type === 'tool_end' && event.data.repair !== undefined).map(event => event.data.repair as Record<string, unknown>);
  assert.ok(repairs.some(repair => repair.kind === 'unit-replay' && typeof repair.decisionId === 'number' && repair.forced === 'value_0'), `journaled repair: ${JSON.stringify(repairs)}`);
});

test('a module-slot failure substitutes the failing leaf in place and re-runs in the same turn', async t => {
  const root = await workspace(t);
  const prompt = 'Write a Python program in main.py that prints a division result.';
  const script: SlotEntry[] = [
    ...planEntries(),
    { slot: 'unit_count', answer: '0' },
    { slot: 'module_body', answer: 'expr', once: true },
    { slot: 'expression', answer: 'call' },
    { slot: 'callee', answer: { value: 'print' } },
    { slot: 'argument_count', answer: '1' },
    { slot: 'argument_0', answer: 'binary' },
    { slot: 'operator', answer: 'Div' },
    { slot: 'left', answer: 'number' }, { slot: 'number', answer: { value: 1 }, once: true },
    { slot: 'right', answer: 'number' }, { slot: 'number', answer: { value: 0 }, once: true },
    { slot: 'module_body', answer: 'finish' },
  ];
  const provider = new RepairProvider(new SlotProvider(script), ['write_file', 'bash', 'finish']);
  const result = await new Harness({ workspace: root, provider, experimentalGrid: true }).run(prompt);

  assert.equal(result.status, 'completed', result.summary);
  const bash = result.records.find(record => record.tool === 'bash')!;
  assert.equal(bash.result.ok, true, bash.result.output);
  assert.match(bash.result.output, /^1\.0$/m);
  assert.ok((await readFile(join(root, 'main.py'), 'utf8')).includes('print(1 / 1)'));
  const repairs = (await journalOf(root, result.id)).filter(event => event.type === 'tool_end' && event.data.repair !== undefined).map(event => event.data.repair as Record<string, unknown>);
  assert.ok(repairs.some(repair => repair.kind === 'module-substitution' && repair.forced === 'value_1'), `journaled repair: ${JSON.stringify(repairs)}`);
});

test('a failing verifier continues the run once and then stops as limited', async t => {
  const root = await workspace(t);
  const events: import('../src/types.js').HarnessEvent[] = [];
  let checks = 0;
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'a.txt', content: 'x' } },
    { action: 'finish', verdict: 1 },
    { action: 'set_plan', args: { plan: 'Fix the checker failure.' } },
    { action: 'finish', verdict: 1 },
  ]);
  const result = await new Harness({ workspace: root, provider, journalDirectory: false,
    verify: async () => { checks++; return { ok: false, reason: `checker says no (${checks})` }; },
    onEvent: event => { events.push(event); } }).run('Write a file.');

  assert.equal(result.status, 'limited');
  assert.equal(checks, 2, 'the verifier runs after each accepted finish and the continuation is bounded to one');
  assert.match(result.summary, /Verification failed after one continuation: checker says no \(2\)/);
  const inputs = events.filter(event => event.type === 'input');
  assert.equal(inputs.length, 1, 'the first failure is journaled as input');
  assert.match((inputs[0]!.data as { instruction: string }).instruction, /Verification failed: checker says no \(1\)/);
});

test('a verify failure is appended as input and the next turn repairs it', async t => {
  const root = await workspace(t);
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'hi.txt', content: 'nope' } },
    { action: 'finish', verdict: 1 },
    { action: 'write_file', args: { path: 'hi.txt', content: 'hi' } },
    { action: 'finish', verdict: 1 },
  ]);
  let checks = 0;
  const result = await new Harness({ workspace: root, provider, journalDirectory: false,
    verify: async ws => { checks++; const content = await readFile(join(ws, 'hi.txt'), 'utf8').catch(() => ''); return { ok: content === 'hi', reason: 'hi.txt must contain hi' }; } }).run('Write hi.');

  assert.equal(result.status, 'completed', result.summary);
  assert.equal(checks, 2, 'the verifier runs again after the continuation');
  assert.equal(await readFile(join(root, 'hi.txt'), 'utf8'), 'hi');
  const continuation = provider.states.find(state => state.task.turn === 3)!;
  assert.ok(continuation.task.updates.some(update => /Verification failed: hi\.txt must contain hi/.test(update)), 'the reason is visible to the next turn');
});

test('a repair that cannot fix the failure journals a note and leaves the failure to the model', async t => {
  const root = await workspace(t);
  const prompt = "Write a Python program in main.py with a helper compute that prints int('x') and int('y').";
  const script: SlotEntry[] = [
    ...planEntries(), { phase: 'plan', answer: 'plan_0', once: true },
    { slot: 'unit_count', answer: '1' },
    { slot: 'unit_0_name', answer: { value: 'compute' } }, { slot: 'unit_0_arity', answer: '0' }, { slot: 'unit_0_purpose', answer: { value: 'compute' } },
    { unit: 'compute', slot: 'function_body', answer: 'return' }, { unit: 'compute', slot: 'expression', answer: 'call' },
    { unit: 'compute', slot: 'callee', answer: { value: 'int' } }, { unit: 'compute', slot: 'argument_count', answer: '1' },
    { unit: 'compute', slot: 'argument_0', answer: 'string' }, { unit: 'compute', slot: 'string', answer: { value: 'x' } },
    { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' }, once: true },
    { slot: 'argument_count', answer: '1' }, { slot: 'argument_0', answer: 'call', once: true }, { slot: 'callee', answer: { value: 'compute' } },
    { slot: 'module_body', answer: 'finish' },
  ];
  const provider = new RepairProvider(new SlotProvider(script), ['write_file', 'bash', 'blocked']);
  const result = await new Harness({ workspace: root, provider, experimentalGrid: true }).run(prompt);

  assert.equal(result.status, 'blocked', result.summary);
  const bash = result.records.find(record => record.tool === 'bash')!;
  assert.equal(bash.result.ok, false, 'the failure stays visible after two failed repair cycles');
  const journal = await journalOf(root, result.id);
  const notes = journal.filter(event => event.type === 'input').map(event => String(event.data.instruction));
  assert.ok(notes.some(note => /Repair budget exhausted for content after 2 cycles/.test(note)), `journal notes: ${JSON.stringify(notes)}`);
  const repairs = journal.filter(event => event.type === 'tool_end' && event.data.repair !== undefined).map(event => event.data.repair as Record<string, unknown>);
  assert.ok(repairs.some(repair => repair.kind === 'unit-replay' && repair.cycle === 1) && repairs.some(repair => repair.cycle === 2), `journaled repair cycles: ${JSON.stringify(repairs)}`);
});

test('a Python traceback that maps to no generated file journals an unattributed-failure note', async t => {
  const root = await workspace(t);
  const command = "python3 -c 'raise ValueError(\"boom\")'";
  const provider = new RepairProvider(new SlotProvider([
    { phase: 'plan', answer: 'plan_0', once: true }, { phase: 'plan', answer: 'plan_0', once: true }, { phase: 'plan', answer: 'plan_0', once: true },
  ]), ['bash', 'blocked']);
  const result = await new Harness({ workspace: root, provider, experimentalGrid: true }).run(`Run the command \`${command}\` and report the failure.`);

  assert.equal(result.status, 'blocked', result.summary);
  assert.equal(result.records[0]?.result.ok, false);
  const journal = await journalOf(root, result.id);
  const notes = journal.filter(event => event.type === 'input').map(event => String(event.data.instruction));
  assert.ok(notes.some(note => /Python traceback could not be attributed to a generated decision/.test(note)), JSON.stringify(notes));
});

test('an over-budget field decision becomes a failed record instead of ending the run', async t => {
  const root = await workspace(t);
  const description = 'M'.repeat(14_000);
  const gadget: Tool = { name: 'gadget', effect: 'read', description: 'Run the gadget.',
    fields: { mode: { type: 'enum', description, choices: { fast: 'Fast.', slow: 'Slow.' } } },
    async execute() { return { ok: true, output: 'gadget ran' }; } };
  const provider = new ScriptedProvider([{ action: 'gadget' }, { action: 'blocked', args: { summary: 'Gadget could not run.' } }]);
  const result = await new Harness({ workspace: root, provider, tools: [...builtInTools(), gadget], experimentalGrid: true, journalDirectory: false }).run('Run the gadget.');

  assert.equal(result.status, 'blocked', result.summary);
  const record = result.records[0]!;
  assert.equal(record.tool, 'gadget');
  assert.equal(record.result.ok, false, 'the over-budget field became a failed record');
  assert.match(record.result.output, /Field decision size failure: path=field, field=mode, bytes=\d+, cap=24000/);
  assert.ok(!provider.states.some(state => state.field === 'mode'), 'no enum request was sent for the over-budget field');
});

test('a size-rejected completion check is labeled as a size failure and the run continues', async t => {
  const root = await workspace(t);
  const blob: Tool = { name: 'blob', effect: 'read', description: 'Return a large observation.',
    fields: {}, async execute() { return { ok: true, output: 'done', data: { blob: 'x'.repeat(30_000) } }; } };
  const provider = new ScriptedProvider([
    { action: 'blob' },
    { action: 'finish', verdict: 1 },
    { action: 'blocked', args: { summary: 'Stopped probing.' } },
  ]);
  const result = await new Harness({ workspace: root, provider, tools: [...builtInTools(), blob], experimentalGrid: true, journalDirectory: false }).run('Probe once, then finish.');

  assert.equal(result.status, 'blocked', result.summary);
  const rejected = result.records.find(record => record.tool === 'finish')!;
  assert.equal(rejected.result.ok, false);
  assert.match(rejected.result.output, /Completion rejected \(1\/3\): size failure/);
  assert.match(rejected.result.output, /path=completion, bytes=\d+, cap=24000, trimmed keys=/);
  assert.ok(!provider.states.some(state => state.completionCheck), 'the over-budget completion check was never sent');
});

test('three consecutive action-size failures end the run as limited with the named fields', async t => {
  const root = await workspace(t);
  const scripted = new ScriptedProvider([
    { action: 'write_file', args: { path: 'yy.txt', content: 'yyyy' } },
    { action: 'finish', verdict: 1 },
  ]);
  const harness = new Harness({ workspace: root, provider: scripted, experimentalGrid: true, journalDirectory: false });
  assert.equal((await harness.run('y'.repeat(3000))).status, 'completed');
  const sent = scripted.states.length;

  const result = await harness.run('z'.repeat(20_000));
  assert.equal(result.status, 'limited', result.summary);
  assert.equal(result.turns, 3);
  assert.match(result.summary, /action decision request exceeds the safe size budget/);
  assert.match(result.summary, /path=action, bytes=\d{4,}, cap=24000, trimmed keys=conversation/);
  assert.equal(scripted.states.length, sent, 'no action request was sent while over budget');
});

test('an over-budget plan select is skipped with a journal note and generation falls back', async t => {
  const root = await workspace(t);
  const literals = Array.from({ length: 40 }, (_, index) => `literal_${index}_${'l'.repeat(200)}`);
  const prompt = 'Write a file that contains ' + literals.map(value => `"${value}"`).join(' ');
  const provider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'main.txt', content: literals[0]! } },
    { action: 'finish', verdict: 1 },
  ]);
  const result = await new Harness({ workspace: root, provider }).run(prompt);

  assert.equal(result.status, 'completed', result.summary);
  assert.equal(await readFile(join(root, 'main.txt'), 'utf8'), literals[0]);
  const journal = await journalOf(root, result.id);
  const notes = journal.filter(event => event.type === 'input').map(event => String(event.data.instruction));
  assert.ok(notes.some(note => /Plan select for content at plan was skipped \(size failure\): path=plan, bytes=\d+, cap=24000/.test(note)), JSON.stringify(notes));
});

test('three size-rejected completion checks end the run as limited with the size cause', async t => {
  const root = await workspace(t);
  const blob: Tool = { name: 'blob', effect: 'read', description: 'Return a large observation.',
    fields: {}, async execute() { return { ok: true, output: 'done', data: { blob: 'x'.repeat(30_000) } }; } };
  const provider = new ScriptedProvider([
    { action: 'blob' }, { action: 'finish', verdict: 1 },
    { action: 'blob' }, { action: 'finish', verdict: 1 },
    { action: 'blob' }, { action: 'finish', verdict: 1 },
  ]);
  const result = await new Harness({ workspace: root, provider, tools: [...builtInTools(), blob], experimentalGrid: true, journalDirectory: false }).run('Probe, then finish.');

  assert.equal(result.status, 'limited', result.summary);
  assert.match(result.summary, /Stopped after 3 rejected completion checks; 3 of them were size failures/);
  assert.match(result.summary, /exceeded the 24000-byte safe size cap after compaction/);
  assert.equal(result.records.filter(record => record.tool === 'finish').length, 3, 'each completion rejection is a failed finish record');
  assert.ok(!provider.states.some(state => state.completionCheck), 'no over-budget completion check was ever sent');
});

test('a prior failure reason survives compaction in the next turn state', async t => {
  const root = await workspace(t);
  const reason = 'ERROR: missing module frobnicate';
  let calls = 0;
  const probe: Tool = { name: 'probe', effect: 'read', description: 'Probe output.',
    fields: {},
    async execute() { calls++; return calls === 6 ? { ok: false, output: `${reason}\n${'x'.repeat(5000)}` } : { ok: true, output: `probe ${calls} ` + 'x'.repeat(5000) }; } };
  const provider = new ScriptedProvider([
    ...Array.from({ length: 6 }, () => ({ action: 'probe' as const })),
    { action: 'finish', verdict: 1 },
  ]);
  const result = await new Harness({ workspace: root, provider, tools: [...builtInTools(), probe], journalDirectory: false }).run('Keep probing until the failure is understood.');

  assert.equal(result.status, 'completed', result.summary);
  const next = provider.states.find(state => state.task.turn === 7)!;
  assert.ok(next, 'the run reached the turn after the failure');
  assert.equal(next.recent.length, 4, 'the action state was compacted to the newest records');
  assert.ok(next.recent.every(record => record.result.output.length <= 820), 'outputs were clipped');
  assert.ok(next.recent.some(record => !record.result.ok && record.result.output.includes(reason)), `failure reason survives: ${JSON.stringify(next.recent.map(record => record.result.output.slice(0, 32)))}`);
});

test('a 60-turn run with large outputs keeps every request under the size cap', async t => {
  const root = await workspace(t);
  let calls = 0;
  const probe: Tool = { name: 'probe', effect: 'write', description: 'Record a probe observation.',
    fields: {},
    async execute() { calls++; return { ok: true, output: `probe ${calls} ` + 'x'.repeat(1500) }; } };
  const inner = new ScriptedProvider([
    ...Array.from({ length: 59 }, () => ({ action: 'probe' as const })),
    { action: 'finish', verdict: 1 },
  ]);
  const provider = new SizeRecordingProvider(inner);
  const result = await new Harness({ workspace: root, provider, tools: [...builtInTools(), probe], maxTurns: 60, journalDirectory: false }).run('Keep probing until done.');

  assert.equal(result.status, 'completed', result.summary);
  assert.equal(result.turns, 60);
  assert.equal(result.requests, 61);
  assert.ok(provider.sizes.every(size => size <= MAX_DECISION_REQUEST_BYTES), `largest request ${Math.max(...provider.sizes)} of ${provider.sizes.length}`);
  const last = inner.states.at(-1) as unknown as { history: Array<{ turn: number }> };
  assert.equal(last.history.length, 16, 'the completion check compacted its history');
});

/** Wraps a scripted provider and records the byte size of every request, mirroring scored-grid tests. */
class SizeRecordingProvider implements DecisionProvider {
  readonly sizes: number[] = [];
  constructor(private readonly inner: ScriptedProvider) {}
  async decide<Q extends Questions>(input: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    this.sizes.push(Buffer.byteLength(JSON.stringify({ state: input, questions })));
    return this.inner.decide(input, questions, signal);
  }
}

test('a completion decision rejected for size retries once with a compacted state', async t => {
  const root = await workspace(t);
  let completionCalls = 0;
  const base = new ScriptedProvider([
    ...Array.from({ length: 5 }, () => ({ action: 'probe' as const })),
    { action: 'finish', verdict: 1 },
  ]);
  const provider: DecisionProvider = { decide: async (input, questions, signal) => {
    if ((input as unknown as { completionCheck?: boolean }).completionCheck === true) {
      completionCalls++;
      if (completionCalls === 1) throw new Error('max_tokens_exceeded: request exceeds the model token budget');
    }
    return base.decide(input, questions, signal);
  } };
  let probes = 0;
  const probe: Tool = { name: 'probe', effect: 'read', description: 'Record a probe observation.', fields: {},
    async execute() { probes++; return { ok: true, output: `probe ${probes}` }; } };
  const result = await new Harness({ workspace: root, provider, tools: [...builtInTools(), probe], journalDirectory: false }).run('Probe five times, then finish.');

  assert.equal(result.status, 'completed', result.summary);
  assert.equal(completionCalls, 2, 'one rejection plus exactly one retry');
  const completionStates = base.states.filter(state => state.completionCheck);
  assert.equal(completionStates.length, 1, 'only the retry reaches the scripted provider');
  assert.equal((completionStates[0] as unknown as { recent: unknown[] }).recent.length, 2, 'the retry state was compacted');
});

test('a repeated size rejection fails the completion decision without another retry', async t => {
  const root = await workspace(t);
  let completionCalls = 0;
  const base = new ScriptedProvider([{ action: 'finish', verdict: 1 }]);
  const provider: DecisionProvider = { decide: async (input, questions, signal) => {
    if ((input as unknown as { completionCheck?: boolean }).completionCheck === true) {
      completionCalls++;
      throw new Error('max_tokens_exceeded: still over budget');
    }
    return base.decide(input, questions, signal);
  } };
  const result = await new Harness({ workspace: root, provider, journalDirectory: false }).run('Finish immediately.');

  assert.equal(result.status, 'error');
  assert.match(result.summary, /max_tokens_exceeded: still over budget/);
  assert.equal(completionCalls, 2, 'the failure propagates after one retry');
});

test('seeded decision paths preserve journaled ids and advance the allocator', async () => {
  const context = createRunContext();
  context.seedDecisions([{ decisionId: 7, scope: attemptScope('content', 'greet'), questionKey: 'string',
    identity: { field: 'content', unit: 'greet' }, chosen: 'value_0', nearTie: true,
    alternatives: [{ label: 'value_0', probability: 0.6 }, { label: 'value_1', probability: 0.4 }] }]);
  assert.equal(context.decisionEntry(7)?.chosen, 'value_0');
  assert.equal(context.decisionEntry(7)?.kind, 'structural', 'seeded entries never enable forced-answer replay');
  assert.deepEqual(context.pathFor(attemptScope('content', 'greet')).map(entry => entry.decisionId), [7]);
  assert.equal(context.allocateDecisionId(), 8, 'new ids continue above the seeded floor');
  await context.dispose();
});

test('an interrupted run resumes at the next turn without replaying journaled tool effects', async t => {
  const root = await workspace(t);
  const controller = new AbortController();
  const firstProvider = new ScriptedProvider([
    { action: 'write_file', args: { path: 'note.txt', content: 'hello' } },
    { action: 'read_file', args: { path: 'note.txt', offset: '', limit: '' } },
  ]);
  const first = await new Harness({ workspace: root, provider: firstProvider,
    onEvent: event => { if (event.type === 'tool_end' && event.data.tool === 'write_file') controller.abort(new Error('Interrupted by user.')); },
  }).run('Write note.txt, then read it back.', controller.signal);
  assert.equal(first.status, 'cancelled', first.summary);
  assert.equal(first.turns, 2, 'the aborted turn still emits its zero-request turn_end');
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'hello');

  const plan = await prepareResume({ journalPath: join(root, '.jev', 'runs', `${first.id}.jsonl`), workspace: root,
    effectOf: name => builtInTools().find(tool => tool.name === name)?.effect });
  assert.equal(plan.turn, 3, 'resume at max(turn_end) + 1');
  assert.equal(plan.turns, 2);
  assert.equal(plan.requests, first.requests, 'carried request usage is summed from turn_end events');
  assert.deepEqual(plan.records.map(record => [record.turn, record.tool]), [[1, 'write_file']]);
  assert.deepEqual(plan.warnings, ['ignored 1 journal event after the last complete turn_end']);

  const secondProvider = new ScriptedProvider([
    { action: 'blocked', args: { summary: 'unused placeholder' } },
    { action: 'blocked', args: { summary: 'unused placeholder' } },
    { action: 'read_file', args: { path: 'note.txt', offset: '', limit: '' } },
    { action: 'finish', verdict: 1 },
  ]);
  const second = await new Harness({ workspace: root, provider: secondProvider, resume: plan }).run(plan.prompt);
  assert.equal(second.status, 'completed', second.summary);
  assert.equal(second.turns, 4, 'turn numbering continues from the resume point');
  assert.equal(second.records[0]?.tool, 'write_file', 'the journaled record is carried into the resumed run');
  assert.equal(second.records.filter(record => record.tool === 'write_file').length, 1, 'the journaled write was not replayed');

  const journal = await journalOf(root, second.id);
  assert.deepEqual(journal[0]!.data.resume, { from: first.id, turns: 2, requests: first.requests });
  assert.deepEqual(journal.filter(event => event.type === 'tool_start').map(event => (event.data as { tool: string }).tool), ['read_file'],
    'the resumed journal only runs new tool calls');
  assert.equal(journal.at(-1)!.type, 'end');
  assert.equal(journal.at(-1)!.data.requests, second.requests, 'end.requests agrees with the live counter');
  const resumedState = secondProvider.states.find(state => state.task.turn === 3) as unknown as { rules: string[] };
  assert.ok(resumedState.rules.some(rule => /resumed from journal/.test(rule)), JSON.stringify(resumedState.rules));
  assert.match(second.summary, /Wrote note.txt\./, 'the carried record feeds the completion summary');
});

test('a resumed run carries request usage into the enforced budget', async t => {
  const root = await workspace(t);
  const firstProvider = new ScriptedProvider([{ action: 'write_file', args: { path: 'a.txt', content: 'a' } }]);
  const first = await new Harness({ workspace: root, provider: firstProvider, maxTurns: 1 }).run('Write a.txt.');
  assert.equal(first.status, 'limited');
  assert.match(first.summary, /Resume this run with jev-code --resume /, 'non-completed runs name their resume command');

  const plan = await prepareResume({ journalPath: join(root, '.jev', 'runs', `${first.id}.jsonl`), workspace: root,
    effectOf: name => builtInTools().find(tool => tool.name === name)?.effect });
  assert.equal(plan.requests, first.requests);

  const secondProvider = new ScriptedProvider([
    { action: 'blocked', args: { summary: 'unused placeholder' } },
    { action: 'blocked', args: { summary: 'Budget exhausted.' } },
  ]);
  const second = await new Harness({ workspace: root, provider: secondProvider, resume: plan, maxRequests: plan.requests + 1, maxTurns: 5 }).run(plan.prompt);
  assert.equal(second.requests, plan.requests + 1, 'the carried requests count against the enforced budget');
  assert.equal(second.status, 'limited', second.summary);
  assert.match(second.summary, /budget exhausted/);
});
