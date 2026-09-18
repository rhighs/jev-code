import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { buildDecisionContext, windowSource, PENDING } from '../src/decision-context.js';
import { Decisions } from '../src/decisions.js';
import { generatePythonAst } from '../src/python-ast.js';
import { MAX_GRID_REQUEST_BYTES } from '../src/scored-grid.js';
import type { DecisionProvider } from '../src/types.js';

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const source = ['import math', ...Array.from({ length: 80 }, (_, i) => `print(${i})`), `print(${PENDING})`, ...Array.from({ length: 80 }, (_, i) => `print(${i + 100})`)].join('\n') + '\n';
const parts = () => [
  { key: 'task', value: { prompt: 'x'.repeat(200) }, required: true },
  { key: 'core', value: { slot: 'argument_0', symbols: ['print'] }, required: true },
  { key: 'source', value: source, shrink: windowSource },
  { key: 'recent', value: [{ tool: 'bash', output: 'y'.repeat(400) }] },
  { key: 'plan', value: 'z'.repeat(300) },
];

test('parts that fit are returned unchanged with nothing trimmed', () => {
  const result = buildDecisionContext(parts(), bytes, 100_000);
  assert.deepEqual(result.trimmed, []);
  assert.deepEqual(Object.keys(result.values), ['task', 'core', 'source', 'recent', 'plan']);
  assert.equal(result.values.source, source);
});

test('over the cap, plan drops first, then recent, then source is windowed; task and core never drop', () => {
  const full = bytes(Object.fromEntries(parts().map(part => [part.key, part.value])));
  const noPlan = buildDecisionContext(parts(), bytes, full - 100);
  assert.deepEqual(noPlan.trimmed, ['plan']);
  assert.ok(!Object.hasOwn(noPlan.values, 'plan') && Object.hasOwn(noPlan.values, 'recent'));
  const noRecent = buildDecisionContext(parts(), bytes, full - 500);
  assert.deepEqual(noRecent.trimmed, ['plan', 'recent']);
  assert.equal(noRecent.values.source, source);
  const windowed = buildDecisionContext(parts(), bytes, 1200);
  assert.deepEqual(windowed.trimmed, ['plan', 'recent', 'source']);
  const text = windowed.values.source as string;
  assert.ok(text.length < source.length);
  assert.ok(text.includes(PENDING) && text.startsWith('import math\n'));
  assert.deepEqual(windowed.values.task, { prompt: 'x'.repeat(200) });
  assert.equal((windowed.values.core as { slot: string }).slot, 'argument_0');
  const tiny = buildDecisionContext(parts(), bytes, 10);
  assert.ok(Object.hasOwn(tiny.values, 'task') && Object.hasOwn(tiny.values, 'core') && Object.hasOwn(tiny.values, 'source'));
});

test('source windows shrink around the pending marker and keep the header', () => {
  const wide = windowSource(source, 1)!;
  const narrow = windowSource(source, 4)!;
  assert.ok(wide.length > narrow.length);
  assert.ok(narrow.includes(`print(${PENDING})`) && narrow.startsWith('import math\n'));
  assert.equal(windowSource('print(1)\n', 1), 'print(1)\n');
  assert.equal(windowSource(narrow, 99), undefined);
});

class LongProvider implements DecisionProvider {
  requests: number[] = [];
  constructor(private script: Array<string | { value: string }>) {}
  async decide<Q extends Questions>(input: EntryType, questions: Q): Promise<SystemOneResult<Q>> {
    this.requests.push(bytes({ state: input, questions }));
    const desired = this.script.shift();
    assert.notEqual(desired, undefined);
    const question = questions.selection!;
    if (question.type !== 'choice') throw new Error('Expected Choice');
    const selection = typeof desired === 'string' ? desired : Object.entries(question.criteria).find(([, label]) => label === desired!.value)?.[0];
    assert.ok(selection, `Unavailable ${JSON.stringify(desired)}`);
    return { model: 'fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: {
      selection: { type: 'choice', choice: selection, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selection)])) },
    } } as unknown as SystemOneResult<Q>;
  }
}

test('a long partial program keeps every decision request under the cap and generation continues', async () => {
  const literal = 'lorem ipsum '.repeat(45).trim();
  const blocks = 3, per = 13, lines = blocks * (per + 1);
  const chunk = (): Array<string | { value: string }> => ['if', 'boolean', 'true', ...Array.from({ length: per }, () => ['expr', 'call', { value: 'print' }, '1', 'string', { value: JSON.stringify(literal) }]).flat(), 'finish', 'no'];
  const script = ['0' as string | { value: string }].concat(Array.from({ length: blocks }, chunk).flat(), 'finish');
  const expected = script.length;
  const provider = new LongProvider(script);
  const decisions = new Decisions(provider, 1000, new AbortController().signal);
  const result = await generatePythonAst(decisions, { task: { prompt: `Python print "${literal}" ${blocks * per} times.` } }, 'content', { maxSteps: 1000, maxBytes: 256_000, allowEmpty: false, fragments: [] });
  assert.equal(result.split('\n').filter(Boolean).length, lines);
  assert.equal(provider.requests.length, expected);
  assert.ok(provider.requests.every(size => size <= MAX_GRID_REQUEST_BYTES), `largest request ${Math.max(...provider.requests)}`);
});
