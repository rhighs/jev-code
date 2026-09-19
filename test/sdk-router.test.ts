import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import {
  DecisionSession,
  defineRouter,
  route,
  runProgram,
  type DecisionProvider,
} from '../src/sdk/index.js';

const choosing = (selected: string): DecisionProvider => ({
  decide: async <Q extends Questions>(_state: EntryType, questions: Q) => {
    const criterion = Object.values(questions)[0] as { criteria: Record<string, string> };
    const labels = Object.keys(criterion.criteria);
    return {
      model: 'router-test',
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        selection: {
          type: 'choice',
          choice: selected,
          confidence: 1,
          probabilities: Object.fromEntries(labels.map(label => [label, label === selected ? 1 : 0])),
        },
      },
    } as unknown as SystemOneResult<Q>;
  },
});

test('a three-route router returns the typed route and decision metadata without executing values', async () => {
  let invoked = false;
  const router = defineRouter({
    billing: route('Questions about invoices', { queue: 'billing' as const }),
    technical: route('Problems using the product', () => { invoked = true; }),
    account: route('Account access requests', { queue: 'account' as const }),
  });

  const selected = await router.select(new DecisionSession(choosing('technical')), { subject: 'It crashes' }, 'Route this ticket.');

  assert.equal(selected.key, 'technical');
  assert.equal(typeof selected.value, 'function');
  assert.equal(invoked, false);
  assert.equal(selected.decision.metadata.model, 'router-test');
});

test('router programs use the run decision resources and preserve route inference', async () => {
  const router = defineRouter({
    accept: route('Accept the request', 200 as const),
    reject: route('Reject the request', 403 as const),
  });
  const program = router.program<{ allowed: boolean }>('route-request', 'Choose an outcome.', input => input);
  const outcome = await runProgram(program, { allowed: true }, {
    provider: choosing('accept'),
    limits: { decisions: 1 },
  });

  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') {
    const status: 200 | 403 = outcome.value.value;
    assert.equal(status, 200);
  }
  assert.equal(outcome.metadata.resources.used.decisions, 1);
});

test('router definitions reject invalid route sets before contacting Jev', () => {
  assert.throws(() => defineRouter({ only: route('Only choice', 1) }), /2-255/);
  assert.throws(() => defineRouter({ a: route('', 1), b: route('B', 2) }), /description/);
});
