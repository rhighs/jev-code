import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import {
  Program,
  DecisionSession,
  RunResources,
  node,
  parallel,
  runProgram,
  value,
  type ProgramEvent,
  type ProgramRunOutcome,
  type DecisionProvider,
} from '../src/sdk/index.js';

const completedValue = <T>(outcome: ProgramRunOutcome<T>): T => {
  assert.equal(outcome.status, 'completed');
  return outcome.value;
};

test('value and map form an immutable typed program with ordered lifecycle events', async () => {
  const base = value<number, number>('base', input => input + 1);
  const doubled = base.map('double', result => result * 2);

  assert.notEqual(base, doubled);
  assert.deepEqual(doubled.inspect().map(item => [item.id, item.kind, item.dependencies]), [
    ['base', 'node', []],
    ['double', 'map', ['base']],
  ]);

  const outcome = await runProgram(doubled, 4);
  assert.equal(completedValue(outcome), 10);
  assert.deepEqual(outcome.metadata.events.map(event => event.sequence),
    outcome.metadata.events.map((_, index) => index + 1));
  assert.equal(outcome.metadata.events.at(0)?.type, 'run-started');
  assert.equal(outcome.metadata.events.at(-1)?.type, 'run-completed');
  assert.equal(outcome.metadata.resources.used.nodes, 2);
});

test('parallel starts independent work within the concurrency bound before its dependent map', async () => {
  const releases: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const starts: string[] = [];
  const child = (id: string) => node<void, string>(id, async () => {
    starts.push(id);
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>(resolve => releases.push(resolve));
    active--;
    return id;
  });
  const joined = parallel('children', [child('left'), child('right')] as const)
    .map('dependent', ([left, right]) => `${left}:${right}`);

  const pending = runProgram(joined, undefined, { concurrency: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, ['left', 'right']);
  assert.equal(peak, 2);
  releases.splice(0).forEach(release => release());

  const outcome = await pending;
  assert.equal(completedValue(outcome), 'left:right');
  const started = outcome.metadata.events.filter(event => event.type === 'node-started').map(event => event.nodeId);
  assert.ok(started.indexOf('dependent') > started.indexOf('left'));
  assert.ok(started.indexOf('dependent') > started.indexOf('right'));
});

test('flatMap admits a validated dynamic child below the parent instance path', async () => {
  const program = value<void, 'leaf'>('root', 'leaf').flatMap('expand', selected =>
    value<void, string>(selected, 'done'));
  const outcome = await runProgram(program, undefined);

  assert.equal(completedValue(outcome), 'done');
  const leaf = outcome.metadata.events.find(event => event.type === 'node-started' && event.nodeId === 'leaf');
  assert.ok(leaf?.type === 'node-started');
  assert.equal(leaf.path, 'expand/leaf');
  assert.equal(leaf.depth, 1);
});

test('a decision inside a node reuses its concurrency permit and emits a versioned decision event', async () => {
  const provider: DecisionProvider = {
    decide: async <Q extends Questions>(_state: EntryType, questions: Q) => ({
      model: 'local',
      usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(questions).map(key => [key, { type: 'noul', noul: 0.75 }])),
    }) as unknown as SystemOneResult<Q>,
  };
  const program = node<void, number>('decision', async ({ decisions }) => {
    assert.ok(decisions);
    return (await decisions.probability({}, 'ready?')).value;
  });
  const outcome = await runProgram(program, undefined, { provider, concurrency: 1, timeoutMs: 100 });

  assert.equal(completedValue(outcome), 0.75);
  assert.ok(outcome.metadata.events.some(event => event.type === 'decision-completed' && event.nodeId === 'decision'));
  assert.equal(outcome.metadata.resources.used.decisions, 1);
});

test('an existing observed decision session shares resources and composes program observers', async () => {
  const observed: string[] = [];
  const provider: DecisionProvider = {
    decide: async <Q extends Questions>(_state: EntryType, questions: Q) => ({
      model: 'local',
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(Object.keys(questions).map(key => [key, { type: 'noul', noul: 0.5 }])),
    }) as unknown as SystemOneResult<Q>,
  };
  const resources = new RunResources({ limits: { decisions: 1 }, concurrency: 1 });
  const session = new DecisionSession(provider, { resources }).observe(() => { observed.push('application'); });
  const program = node<void, number>('shared', async ({ decisions }) => {
    assert.ok(decisions);
    return (await decisions.probability({}, 'ready?')).value;
  });

  const outcome = await runProgram(program, undefined, {
    session,
    onEvent: event => { if (event.type === 'decision-completed') observed.push('program'); },
  });

  assert.equal(completedValue(outcome), 0.5);
  assert.deepEqual(observed, ['application', 'program']);
  assert.equal(resources.snapshot().used.decisions, 1);
  assert.equal(outcome.metadata.resources.used.decisions, 1);
});

test('concurrent invocations of one definition isolate values, counters, events, and run IDs', async () => {
  const program = node<number, number>('input', async ({ input }) => {
    await new Promise(resolve => setImmediate(resolve));
    return input;
  }).map('output', result => result * 10);

  const [first, second] = await Promise.all([runProgram(program, 2), runProgram(program, 7)]);
  assert.equal(completedValue(first), 20);
  assert.equal(completedValue(second), 70);
  assert.notEqual(first.metadata.runId, second.metadata.runId);
  assert.equal(first.metadata.events[0]?.sequence, 1);
  assert.equal(second.metadata.events[0]?.sequence, 1);
  assert.equal(first.metadata.resources.used.nodes, 2);
  assert.equal(second.metadata.resources.used.nodes, 2);
});

test('node and dynamic depth budgets produce discriminated non-completed outcomes', async () => {
  const nodes = value<void, number>('one', 1).map('two', value => value + 1);
  const exhausted = await runProgram(nodes, undefined, { limits: { nodes: 1 } });
  assert.equal(exhausted.status, 'exhausted');
  if (exhausted.status === 'exhausted') {
    assert.equal(exhausted.evidence.kind, 'exhausted');
    if (exhausted.evidence.kind === 'exhausted') assert.equal(exhausted.evidence.resource, 'nodes');
  }

  const dynamic = value<void, number>('root', 1).flatMap('expand', () => value<void, number>('child', 2));
  const invalid = await runProgram(dynamic, undefined, { maxDepth: 0 });
  assert.equal(invalid.status, 'invalid');
  if (invalid.status === 'invalid') assert.match(invalid.detail, /depth/i);
});

test('invalid static identity and expanding child limits throw before a run starts', async () => {
  assert.throws(() => parallel('duplicate', [value<void, number>('same', 1), value<void, number>('same', 2)]), /duplicate/i);

  const narrowed = value<void, number>('leaf', 1).withLimits({ nodes: 4 }).withLimits({ nodes: 3 });
  await assert.rejects(runProgram(narrowed, undefined, { limits: { nodes: 5 } }), /cannot exceed parent/i);
});

test('failure aborts unfinished siblings, drains started work, and emits one terminal event last', async () => {
  let siblingSettled = false;
  const broken = node<void, never>('broken', async () => {
    await new Promise(resolve => setImmediate(resolve));
    throw new Error('boom');
  });
  const sibling = node<void, string>('sibling', async ({ signal }) => {
    try {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return 'unreachable';
    } finally {
      siblingSettled = true;
    }
  });
  const events: ProgramEvent[] = [];
  const outcome = await runProgram(parallel('both', [broken, sibling] as const), undefined, {
    onEvent: event => { events.push(event); },
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(siblingSettled, true);
  assert.equal(events.filter(event => event.type.startsWith('run-') && event.type !== 'run-started').length, 1);
  assert.equal(events.at(-1)?.type, 'run-failed');
});

test('failed final validation cannot expose a completed value', async () => {
  const outcome = await runProgram(value<void, number>('answer', 42), undefined, {
    validate: result => result === 7 || 'answer must be seven',
  });
  assert.equal(outcome.status, 'invalid');
  if (outcome.status === 'invalid') assert.equal(outcome.detail, 'answer must be seven');
  assert.equal('value' in outcome, false);
  assert.equal(outcome.metadata.events.at(-1)?.type, 'run-invalid');
});

test('deadline expiry during final validation wins over a successful validator result', async () => {
  const outcome = await runProgram(value<void, number>('answer', 42), undefined, {
    timeoutMs: 5,
    validate: async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return true;
    },
  });
  assert.equal(outcome.status, 'exhausted');
  if (outcome.status === 'exhausted') assert.equal(outcome.evidence.kind, 'deadline-exceeded');
});

test('external cancellation has a distinct outcome and no events follow the terminal event', async () => {
  const controller = new AbortController();
  const program = node<void, void>('waiting', async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const pending = runProgram(program, undefined, { signal: controller.signal });
  controller.abort(new Error('stop now'));
  const outcome = await pending;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.metadata.events.at(-1)?.type, 'run-cancelled');
});

test('event delivery applies backpressure while metadata retains a bounded ordered tail', async () => {
  let active = 0;
  let peak = 0;
  const delivered: ProgramEvent[] = [];
  const program = value<void, number>('one', 1)
    .map('two', value => value + 1)
    .map('three', value => value + 1);
  const outcome = await runProgram(program, undefined, {
    maxRetainedEvents: 3,
    onEvent: async event => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      delivered.push(event);
      active--;
    },
  });

  assert.equal(outcome.status, 'completed');
  assert.equal(peak, 1);
  assert.equal(delivered.at(-1)?.type, 'run-completed');
  assert.equal(delivered.filter(event => event.type === 'run-completed').length, 1);
  assert.equal(outcome.metadata.events.length, 3);
  assert.ok(outcome.metadata.droppedEvents > 0);
  assert.equal(outcome.metadata.events.at(-1)?.type, 'run-completed');
  assert.deepEqual(outcome.metadata.events.map(event => event.sequence), delivered.slice(-3).map(event => event.sequence));
});

test('default depth prevents unbounded decision-free dynamic expansion', async () => {
  const expanding = (remaining: number): Program<void, number> => value<void, number>(`value-${remaining}`, remaining)
    .flatMap(`expand-${remaining}`, () => remaining === 0
      ? value<void, number>('done', 0)
      : expanding(remaining - 1));

  const outcome = await runProgram(expanding(300), undefined);
  assert.equal(outcome.status, 'invalid');
  if (outcome.status === 'invalid') assert.match(outcome.detail, /depth/i);
  assert.equal(outcome.metadata.events.at(-1)?.type, 'run-invalid');
});

test('parallel tuples and data-dependent programs preserve output inference', () => {
  const tuple = parallel('tuple', [value<void, number>('count', 1), value<void, string>('name', 'one')] as const);
  const inferred: Program<void, readonly [number, string]> = tuple;
  const dynamic: Program<void, boolean> = inferred.flatMap('dynamic', ([count]) => value<void, boolean>('valid', count > 0));
  assert.ok(dynamic instanceof Program);
});
