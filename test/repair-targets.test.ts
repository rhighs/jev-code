import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Harness } from '../src/harness.js';
import type { DecisionProvider, ToolRepairRecord } from '../src/types.js';
import { SlotProvider, type SlotEntry } from './helpers.js';

async function workspace(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'jev-repair-target-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/**
 * Scripts actions and non-AST fields; Python generation is delegated to a SlotProvider. The path
 * field falls back to the paths list when plan selection does not answer it first.
 */
class MixedProvider implements DecisionProvider {
  readonly astStates: Array<{ slot: string; unit?: string; candidate?: number }> = [];
  writes = 0;
  constructor(private readonly slot: SlotProvider, private readonly actions: string[], private readonly paths: string[]) {}
  async decide<Q extends Questions>(input: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    const state = input as unknown as { task: { turn: number }; generation?: { slot?: string; unit?: string; candidate?: number }; completionCheck?: boolean; field?: string };
    if (state.generation !== undefined) {
      this.astStates.push({ slot: state.generation.slot ?? '', ...(state.generation.unit === undefined ? {} : { unit: state.generation.unit }), ...(state.generation.candidate === undefined ? {} : { candidate: state.generation.candidate }) });
      return this.slot.decide(input, questions, signal);
    }
    const question = (questions as Record<string, { type: string; criteria: Record<string, string> }>).selection;
    if (question === undefined || question.type !== 'choice') throw new Error('MixedProvider: unexpected question');
    const selected = state.completionCheck ? 'complete'
      : state.field === 'path' ? (this.paths[this.writes++] ?? 'main.py')
      : state.field === 'timeout_ms' ? 'default'
      : state.field !== undefined ? Object.keys(question.criteria)[0]!
      : this.actions[state.task.turn - 1]!;
    return { model: 'repair-targets', usage: { input_tokens: 1, output_tokens: 0 }, answers: {
      selection: { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, label === selected ? 1 : 0])) },
    } } as unknown as SystemOneResult<Q>;
  }
}

/** One helper unit named `compute` returning `literal`, then a main block that prints it. */
const unitFile = (literal: string, once = true): SlotEntry[] => [
  { slot: 'unit_count', answer: '1', once },
  { slot: 'unit_0_name', answer: { value: 'compute' }, once }, { slot: 'unit_0_arity', answer: '0', once }, { slot: 'unit_0_purpose', answer: { value: 'compute' }, once },
  { unit: 'compute', slot: 'function_body', answer: 'return', once }, { unit: 'compute', slot: 'expression', answer: 'string', once },
  { unit: 'compute', slot: 'string', answer: { value: literal }, once },
  { slot: 'module_body', answer: 'expr', once }, { slot: 'expression', answer: 'call', once }, { slot: 'callee', answer: { value: 'print' }, once },
  { slot: 'argument_count', answer: '1', once }, { slot: 'argument_0', answer: 'call', once }, { slot: 'callee', answer: { value: 'compute' }, once },
  { slot: 'module_body', answer: 'finish', once },
];

test('two single-file targets in one run do not share a unit cache entry', async t => {
  const root = await workspace(t);
  const prompt = 'Write a Python program with a helper compute. First a.py then b.py.';
  const script: SlotEntry[] = [
    // a.py: one unit named compute returning 'a.py'
    ...unitFile('a.py'),
    // b.py: the same shape must be regenerated for the new target, returning 'b.py'
    ...unitFile('b.py'),
    // plan phases: path selections a.py then b.py
    { phase: 'plan', answer: 'plan_0', once: true }, { phase: 'plan', answer: 'plan_1', once: true },
  ];
  const provider = new MixedProvider(new SlotProvider(script), ['write_file', 'write_file', 'finish'], ['a.py', 'b.py']);
  const result = await new Harness({ workspace: root, provider, journalDirectory: false, authorize: () => true }).run(prompt);

  assert.equal(result.status, 'completed', result.summary);
  assert.match(await readFile(join(root, 'a.py'), 'utf8'), /def compute\(\):\n    return 'a\.py'\n/);
  assert.match(await readFile(join(root, 'b.py'), 'utf8'), /def compute\(\):\n    return 'b\.py'\n/, 'b.py must not inherit a.py helpers');
  assert.equal(provider.astStates.filter(state => state.slot === 'unit_count').length, 2, 'the second target asks its own unit questions');
  const records = result.records.filter(record => record.tool === 'write_file');
  assert.deepEqual(records.map(record => record.args.path), ['a.py', 'b.py']);
  assert.ok(records.every(record => record.result.ok), JSON.stringify(records.map(record => record.result.output)));
});

test('a declined repair write is retried on the next failure instead of blocking repair', async t => {
  const root = await workspace(t);
  const prompt = "Write a Python program in main.py with a helper compute that prints int('5'); do not print int('x').";
  const script: SlotEntry[] = [
    // path, then command+cwd for each of the two bash calls
    { phase: 'plan', answer: 'plan_0', once: true }, { phase: 'plan', answer: 'plan_0', once: true }, { phase: 'plan', answer: 'plan_0', once: true },
    { phase: 'plan', answer: 'plan_0', once: true }, { phase: 'plan', answer: 'plan_0', once: true },
    { slot: 'unit_count', answer: '1' },
    { slot: 'unit_0_name', answer: { value: 'compute' } }, { slot: 'unit_0_arity', answer: '0' }, { slot: 'unit_0_purpose', answer: { value: 'compute' } },
    { unit: 'compute', slot: 'function_body', answer: 'return' }, { unit: 'compute', slot: 'expression', answer: 'call' },
    { unit: 'compute', slot: 'callee', answer: { value: 'int' } }, { unit: 'compute', slot: 'argument_count', answer: '1' },
    { unit: 'compute', slot: 'argument_0', answer: 'string' }, { unit: 'compute', slot: 'string', answer: { value: 'x' }, runnerUp: '5', once: true },
    // Fallback if the retry after the declined write has to regenerate instead of replaying.
    { unit: 'compute', slot: 'string', answer: { value: '5' } },
    { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' }, once: true },
    { slot: 'argument_count', answer: '1' }, { slot: 'argument_0', answer: 'call', once: true }, { slot: 'callee', answer: { value: 'compute' } },
    { slot: 'module_body', answer: 'finish' },
  ];
  const provider = new MixedProvider(new SlotProvider(script), ['write_file', 'bash', 'bash', 'finish'], ['main.py']);
  let writes = 0;
  const result = await new Harness({ workspace: root, provider, experimentalGrid: true,
    authorize: tool => { if (tool.name !== 'write_file') return true; writes++; return writes !== 2; } }).run(prompt);

  assert.equal(result.status, 'completed', result.summary);
  assert.equal(writes, 3, 'the original write, the declined repair, and the accepted repair');
  const bashRecords = result.records.filter(record => record.tool === 'bash');
  assert.equal(bashRecords.length, 2);
  assert.equal(bashRecords[0]!.result.ok, false, 'the declined repair left the first failure visible');
  assert.equal(bashRecords[1]!.result.ok, true, bashRecords[1]!.result.output);
  assert.match(bashRecords[1]!.result.output, /^5$/m, 'the retried repair fixed the program');
  assert.match(await readFile(join(root, 'main.py'), 'utf8'), /return int\('5'\)/);
  const journal = (await readFile(join(root, '.jev', 'runs', `${result.id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; data: Record<string, unknown> & { repair?: ToolRepairRecord } });
  const notes = journal.filter(event => event.type === 'input').map(event => String(event.data.instruction));
  assert.ok(notes.some(note => /repair write for main\.py was declined or failed/.test(note)), JSON.stringify(notes));
  const repairs = journal.flatMap(event => event.type === 'tool_end' && event.data.repair !== undefined ? [event.data.repair] : []);
  assert.ok(repairs.some(repair => repair.kind === 'unit-replay' && repair.forced === 'value_0' && repair.cycle === 1), `journaled repairs: ${JSON.stringify(repairs)}`);
});
