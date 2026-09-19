import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import {
  TreeDefinitionError,
  branch,
  complete,
  runTree,
  slot,
  type BranchProduction,
  type DecisionProvider,
  type TreeSlot,
} from '../src/sdk/index.js';

const choosing = (choices: readonly string[], inspect?: (labels: readonly string[]) => void): DecisionProvider => {
  let index = 0;
  return {
    decide: async <Q extends Questions>(_state: EntryType, questions: Q) => {
      const criterion = Object.values(questions)[0] as { criteria: Record<string, string> };
      const labels = Object.keys(criterion.criteria);
      inspect?.(labels);
      const selected = choices[index++] ?? labels[0]!;
      return {
        model: 'tree-test', usage: { input_tokens: 0, output_tokens: 0 },
        answers: {
          selection: {
            type: 'choice', choice: selected, confidence: 1,
            probabilities: Object.fromEntries(labels.map(label => [label, label === selected ? 1 : 0])),
          },
        },
      } as unknown as SystemOneResult<Q>;
    },
  };
};

interface MenuNode {
  readonly label: string;
  readonly children?: readonly MenuNode[];
}

const menuSlot = (id: string, depth: number): TreeSlot<{ vegetarian: boolean }, MenuNode> => {
  const leaf = complete<{ vegetarian: boolean }, MenuNode>(
    'item',
    'A menu item',
    () => ({ label: depth === 2 ? 'Mushroom pie' : 'Soup' }),
  );
  if (depth === 2) return slot({ id, description: 'Menu item', productions: [leaf], validate: node => node.label.length > 0 });
  const starter = menuSlot(`${id}-starter`, depth + 1);
  const main = menuSlot(`${id}-main`, depth + 1);
  return slot({
    id,
    description: 'Menu section',
    productions: [
      leaf,
      branch('section', 'A section with a starter and main', { starter, main }, children => ({
        label: `Course ${depth}`,
        children: [children.starter, children.main],
      })),
    ],
    validate: node => node.label.length > 0 && (node.children === undefined || node.children.length === 2),
  });
};

test('a recursive non-code grammar chooses finite productions and assembles a validated tree', async () => {
  const outcome = await runTree(menuSlot('menu', 0), { vegetarian: true }, {
    provider: choosing(['section', 'section', 'item', 'item', 'section', 'item', 'item']),
    concurrency: 4,
    state: (treeSlot, input) => ({ slot: treeSlot.id, vegetarian: input.vegetarian }),
    validate: tree => tree.label === 'Course 0' || 'menu root is invalid',
  });

  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') {
    assert.equal(outcome.value.label, 'Course 0');
    assert.equal(outcome.value.children?.length, 2);
    assert.equal(outcome.value.children?.[0]?.children?.[0]?.label, 'Mushroom pie');
  }
  assert.ok(outcome.metadata.resources.used.decisions >= 3);
  assert.equal(outcome.metadata.events.at(-1)?.type, 'run-completed');
});

test('a structural singleton resolves without Jev', async () => {
  const root = slot<void, string>({
    id: 'singleton', description: 'Forced value',
    productions: [complete('only', 'The only structural option', () => 'done')],
  });
  const outcome = await runTree(root, undefined, { limits: { decisions: 0 } });

  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.value, 'done');
  assert.equal(outcome.metadata.resources.used.decisions, 0);
});

test('invalid productions are filtered before Jev chooses', async () => {
  const offered: string[][] = [];
  const root = slot<{ enabled: boolean }, string>({
    id: 'filtered', description: 'Filtered choice',
    productions: [
      complete('disabled', 'Unavailable option', () => 'disabled', input => input.enabled),
      complete('left', 'Left option', () => 'left'),
      complete('right', 'Right option', () => 'right'),
    ],
  });
  const outcome = await runTree(root, { enabled: false }, {
    provider: choosing(['right'], labels => offered.push([...labels])),
  });

  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.value, 'right');
  assert.deepEqual(offered, [['left', 'right']]);
});

test('independent child slots run concurrently before deterministic assembly', async () => {
  const releases: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const child = (id: string) => slot<void, string>({
    id, description: id,
    productions: [complete('value', `Build ${id}`, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return id;
    })],
  });
  const root = slot<void, string>({
    id: 'root', description: 'Joined value',
    productions: [branch('pair', 'Pair both values', { left: child('left'), right: child('right') }, values => `${values.left}:${values.right}`)],
  });

  const pending = runTree(root, undefined, { concurrency: 2 });
  for (let attempt = 0; attempt < 10 && releases.length < 2; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 2);
  releases.splice(0).forEach(release => release());
  const outcome = await pending;
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.value, 'left:right');
});

test('node and depth limits return exhaustive outcomes without a partial tree', async () => {
  const root = menuSlot('bounded', 0);
  const exhausted = await runTree(root, { vegetarian: true }, {
    provider: choosing(['section']), limits: { nodes: 2 },
  });
  assert.equal(exhausted.status, 'exhausted');
  assert.equal('value' in exhausted, false);

  const tooDeep = await runTree(root, { vegetarian: true }, {
    provider: choosing(['section']), maxDepth: 0,
  });
  assert.equal(tooDeep.status, 'invalid');
  assert.equal('value' in tooDeep, false);

  const requests = await runTree(root, { vegetarian: true }, {
    provider: choosing(['section']), limits: { decisions: 0 },
  });
  assert.equal(requests.status, 'exhausted');
  if (requests.status === 'exhausted' && requests.evidence.kind === 'exhausted') {
    assert.equal(requests.evidence.resource, 'decisions');
  }
});

test('empty production sets and node or final validators reject completion', async () => {
  const empty = slot<void, string>({ id: 'empty', description: 'No choices', productions: [] });
  const noChoice = await runTree(empty, undefined);
  assert.equal(noChoice.status, 'invalid');

  const invalidNode = slot<void, string>({
    id: 'node-invalid', description: 'Invalid node',
    productions: [complete('only', 'Only value', () => 'bad')],
    validate: () => 'node rejected',
  });
  const nodeOutcome = await runTree(invalidNode, undefined);
  assert.equal(nodeOutcome.status, 'invalid');
  if (nodeOutcome.status === 'invalid') assert.equal(nodeOutcome.detail, 'node rejected');

  const finalOutcome = await runTree(slot<void, string>({
    id: 'final-invalid', description: 'Final value',
    productions: [complete('only', 'Only value', () => 'valid node')],
  }), undefined, { validate: () => 'final tree rejected' });
  assert.equal(finalOutcome.status, 'invalid');
  assert.equal('value' in finalOutcome, false);
});

test('duplicate, cyclic, and missing slot dependencies fail before a run starts', async () => {
  const child = slot<void, string>({ id: 'child', description: 'Child', productions: [complete('leaf', 'Leaf', () => 'x')] });
  const duplicate = slot<void, string>({
    id: 'duplicate', description: 'Duplicate child',
    productions: [branch('pair', 'Pair', { first: child, second: child }, values => values.first + values.second)],
  });
  await assert.rejects(runTree(duplicate, undefined), (error: unknown) => error instanceof TreeDefinitionError && /duplicate/i.test(error.message));

  const cycleChildren: Record<string, TreeSlot<void, unknown>> = {};
  const cyclicProduction: BranchProduction<void, string> = {
    kind: 'branch', id: 'loop', description: 'Loop', children: cycleChildren,
    assemble: () => 'never',
  };
  const cyclic = slot<void, string>({ id: 'cyclic', description: 'Cyclic', productions: [cyclicProduction] });
  cycleChildren.self = cyclic;
  await assert.rejects(runTree(cyclic, undefined), /cycle/i);

  const missing = slot<void, string>({
    id: 'missing', description: 'Missing child',
    productions: [branch('broken', 'Broken', { absent: undefined as never }, () => 'never')],
  });
  await assert.rejects(runTree(missing, undefined), /missing child/i);
});

test('production validation is bounded before dispatch and receives cancellation context', async () => {
  let calls = 0;
  const tooMany = slot<void, string>({
    id: 'too-many',
    description: 'Too many choices',
    productions: Array.from({ length: 256 }, (_, index) => complete(`choice-${index}`, 'Choice', () => 'value', () => { calls++; })),
  });
  await assert.rejects(runTree(tooMany, undefined, { provider: choosing([]) }), /more than 255 productions/i);
  assert.equal(calls, 0);

  let sawContext = false;
  const validated = slot<void, string>({
    id: 'validated',
    description: 'Validated choice',
    productions: [complete('only', 'Only choice', () => 'value', (_input, context) => {
      sawContext = context.signal === context.resources.signal;
      return true;
    })],
  });
  const outcome = await runTree(validated, undefined);
  assert.equal(outcome.status, 'completed');
  assert.equal(sawContext, true);
});
