import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import {
  DecisionProgram,
  DecisionSession,
  LimitError,
  fromInput,
  node,
  parallel,
  runProgram,
  value,
  type ProgramEvent,
  type ProgramRunOutcome,
  type DecisionProvider,
} from '../src/sdk/index.js';
import { createDecisionSession } from '../src/sdk/decisions.js';
import { RunResources } from '../src/sdk/resources.js';

const completedValue = <T>(outcome: ProgramRunOutcome<T>): T => {
  assert.equal(outcome.status, 'completed');
  return outcome.value;
};

const responseProvider = (answer: unknown, onCall: () => void = () => {}): DecisionProvider => ({
  decide: async <Q extends Questions>(_state: EntryType, questions: Q) => {
    onCall();
    return {
      model: 'program-test', usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(questions).map(key => [key, answer])),
    } as unknown as SystemOneResult<Q>;
  },
});

test('value and map form an immutable typed program with ordered lifecycle events', async () => {
  const base = fromInput<number, number>('base', input => input + 1);
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

test('value preserves function constants while fromInput evaluates factories', async () => {
  const constant = () => 'constant';
  const constantOutcome = await runProgram(value<number, typeof constant>('function', constant), 3);
  assert.equal(completedValue(constantOutcome), constant);
  assert.equal(completedValue(await runProgram(fromInput<number, number>('factory', input => input + 1), 3)), 4);
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

test('concurrent decisions inside one node share the provider concurrency bound without deadlocking', async () => {
  for (const concurrency of [1, 2]) {
    let active = 0;
    let peak = 0;
    const provider: DecisionProvider = {
      decide: async <Q extends Questions>(_state: EntryType, questions: Q) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return {
          model: 'bounded', usage: { input_tokens: 0, output_tokens: 0 },
          answers: Object.fromEntries(Object.keys(questions).map(key => [key, { type: 'noul', noul: 0.5 }])),
        } as unknown as SystemOneResult<Q>;
      },
    };
    const program = node<void, number[]>('decisions', async ({ decisions }) => {
      assert.ok(decisions);
      const results = await Promise.all(Array.from({ length: 4 }, (_, index) =>
        decisions.probability({ index }, 'ready?')));
      return results.map(result => result.value);
    });

    const outcome = await runProgram(program, undefined, { provider, concurrency, timeoutMs: 500 });
    assert.deepEqual(completedValue(outcome), [0.5, 0.5, 0.5, 0.5]);
    assert.equal(peak, concurrency);
  }
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
  const session = createDecisionSession(provider, resources).observe(() => { observed.push('application'); });
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

test('program runs reject simultaneous provider and session options at runtime', async () => {
  const provider = responseProvider({ type: 'noul', noul: 1 });
  await assert.rejects(runProgram(value<void, number>('answer', 1), undefined, {
    provider,
    session: new DecisionSession(provider),
  } as never), /either provider or session/i);
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
  assert.throws(() => value<void, number>('first', 1).map('second', value => value).map('first', value => value), /duplicate static node path/i);
  assert.throws(() => parallel('nested-duplicate', [
    value<void, number>('shared', 1).map('mapped', value => value),
    value<void, number>('shared', 2),
  ] as const), /duplicate static node path/i);

  const narrowed = value<void, number>('leaf', 1).withLimits({ nodes: 4 }).withLimits({ nodes: 3 });
  await assert.rejects(runProgram(narrowed, undefined, { limits: { nodes: 5 } }), /cannot exceed parent/i);
});

test('scoped resource snapshots expose effective limits', async () => {
  const resources = new RunResources({ limits: { decisions: 8, nodes: 8 } });
  assert.deepEqual(resources.fork(undefined, { decisions: 3, nodes: 4 }).snapshot().limits, { decisions: 3, nodes: 4 });

  const scoped = node<void, { decisions: number; nodes: number }>('snapshot', ({ resources: current }) =>
    current.snapshot().limits).withLimits({ decisions: 2, nodes: 3 });
  const outcome = await runProgram(scoped, undefined, { limits: { decisions: 6, nodes: 6 } });
  assert.deepEqual(completedValue(outcome), { decisions: 2, nodes: 3 });
});

test('scoped decision and node budgets are enforced during execution', async () => {
  let calls = 0;
  const provider = responseProvider({ type: 'noul', noul: 1 }, () => { calls++; });
  const decisionScoped = node<void, number>('first', async ({ decisions }) => {
    await decisions!.probability({}, 'first');
    await decisions!.probability({}, 'second');
    return 2;
  }).withLimits({ decisions: 1, nodes: 2 });
  const decisionOutcome = await runProgram(decisionScoped, undefined, {
    provider, limits: { decisions: 4, nodes: 4 },
  });
  assert.equal(decisionOutcome.status, 'exhausted');
  assert.equal(calls, 1);
  if (decisionOutcome.status === 'exhausted' && decisionOutcome.evidence.kind === 'exhausted') {
    assert.equal(decisionOutcome.evidence.resource, 'decisions');
    assert.equal(decisionOutcome.evidence.limit, 1);
  }

  const nodeScoped = value<void, number>('one', 1).map('two', value => value + 1).withLimits({ nodes: 1 });
  const nodeOutcome = await runProgram(nodeScoped, undefined, { limits: { nodes: 4 } });
  assert.equal(nodeOutcome.status, 'exhausted');
  if (nodeOutcome.status === 'exhausted' && nodeOutcome.evidence.kind === 'exhausted') {
    assert.equal(nodeOutcome.evidence.resource, 'nodes');
    assert.equal(nodeOutcome.evidence.limit, 1);
  }
});

test('application LimitError is a failed host operation, not fabricated SDK exhaustion', async () => {
  const outcome = await runProgram(node<void, never>('host-limit', () => {
    throw new LimitError('host byte limit');
  }), undefined);
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') assert.match(outcome.detail, /host byte limit/);
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

test('cancellation and deadline after node-started retain their outcome classifications', async () => {
  const controller = new AbortController();
  const cancelled = await runProgram(node<void, void>('active', async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }), undefined, {
    signal: controller.signal,
    onEvent: event => { if (event.type === 'node-started') controller.abort(new Error('active stop')); },
  });
  assert.equal(cancelled.status, 'cancelled');

  const exhausted = await runProgram(node<void, void>('active', async () => {
    await new Promise(() => {});
  }), undefined, { timeoutMs: 10 });
  assert.equal(exhausted.status, 'exhausted');
  if (exhausted.status === 'exhausted') assert.equal(exhausted.evidence.kind, 'deadline-exceeded');
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

test('event observer rejection fails the run and a stalled observer is bounded', async () => {
  const rejected = await runProgram(value<void, number>('answer', 42), undefined, {
    onEvent: event => {
      if (event.type === 'node-started') throw new Error('observer offline');
    },
  });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.metadata.events.filter(event => event.type.startsWith('run-') && event.type !== 'run-started').length, 1);
  assert.equal(rejected.metadata.events.at(-1)?.type, 'run-failed');

  const stalled = await runProgram(value<void, number>('answer', 42), undefined, {
    eventTimeoutMs: 10,
    onEvent: event => event.type === 'node-started' ? new Promise<void>(() => {}) : undefined,
  });
  assert.equal(stalled.status, 'failed');
  if (stalled.status === 'failed') assert.match(stalled.detail, /observer did not settle/i);

  const controller = new AbortController();
  const pending = runProgram(value<void, number>('answer', 42), undefined, {
    signal: controller.signal,
    eventTimeoutMs: 10_000,
    onEvent: event => event.type === 'node-started' ? new Promise<void>(() => {}) : undefined,
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancel observer'));
  assert.equal((await pending).status, 'cancelled');
});

test('terminal observer failures are reported without delivering a second terminal event', async () => {
  const check = async (
    expected: ProgramRunOutcome<unknown>['status'],
    run: (onEvent: (event: ProgramEvent) => void | Promise<void>) => Promise<ProgramRunOutcome<unknown>>,
  ): Promise<void> => {
    const terminals: ProgramEvent[] = [];
    const outcome = await run(event => {
      if (event.type.startsWith('run-') && event.type !== 'run-started') {
        terminals.push(event);
        throw new Error(`cannot deliver ${event.type}`);
      }
    });
    assert.equal(outcome.status, expected);
    assert.equal(terminals.length, 1);
    assert.equal(outcome.metadata.events.filter(event => event.type.startsWith('run-') && event.type !== 'run-started').length, 1);
    assert.match(outcome.metadata.observerFailure?.detail ?? '', /cannot deliver run-/);
  };

  await check('completed', onEvent => runProgram(value<void, number>('complete', 1), undefined, { onEvent }));
  await check('failed', onEvent => runProgram(node<void, never>('fail', () => { throw new Error('boom'); }), undefined, { onEvent }));
  await check('invalid', onEvent => runProgram(value<void, number>('invalid', 1), undefined, { validate: () => false, onEvent }));
  await check('exhausted', onEvent => runProgram(value<void, number>('exhausted', 1), undefined, { limits: { nodes: 0 }, onEvent }));

  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  await check('cancelled', onEvent => runProgram(value<void, number>('cancelled', 1), undefined, {
    signal: controller.signal, onEvent,
  }));

  const stalledTerminals: ProgramEvent[] = [];
  const timedOut = await runProgram(value<void, number>('terminal-timeout', 1), undefined, {
    eventTimeoutMs: 10,
    onEvent: event => {
      if (event.type === 'run-completed') {
        stalledTerminals.push(event);
        return new Promise(() => {});
      }
      return undefined;
    },
  });
  assert.equal(timedOut.status, 'completed');
  assert.equal(stalledTerminals.length, 1);
  assert.match(timedOut.metadata.observerFailure?.detail ?? '', /did not settle/i);
});

test('parallel schedules bounded workers and preserves tuple order', async () => {
  let active = 0;
  let peak = 0;
  const children = Array.from({ length: 20 }, (_, index) => node<void, number>(`child-${index}`, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, index % 3));
    active--;
    return index;
  }));
  const outcome = await runProgram(parallel('many', children), undefined, { concurrency: 3 });
  assert.deepEqual(completedValue(outcome), Array.from({ length: 20 }, (_, index) => index));
  assert.equal(peak, 3);
});

test('default depth prevents unbounded decision-free dynamic expansion', async () => {
  const expanding = (remaining: number): DecisionProgram<void, number> => value<void, number>(`value-${remaining}`, remaining)
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
  const inferred: DecisionProgram<void, readonly [number, string]> = tuple;
  const dynamic: DecisionProgram<void, boolean> = inferred.flatMap('dynamic', ([count]) => value<void, boolean>('valid', count > 0));
  assert.ok(dynamic instanceof DecisionProgram);

  if (false) {
    // @ts-expect-error parallel children must accept one compatible input type
    parallel('incompatible', [value<string, number>('string-input', 1), value<number, number>('number-input', 2)] as const);
  }
});
