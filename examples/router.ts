import {
  DecisionSession,
  defineRouter,
  route,
  type DecisionProvider,
} from 'jev-code';

const choose = (selection: string): DecisionProvider => ({
  async decide(_state, questions) {
    const question = Object.values(questions)[0] as { criteria: Record<string, string> };
    const labels = Object.keys(question.criteria);
    return {
      model: 'deterministic-example',
      usage: { input_tokens: 0, output_tokens: 0 },
      answers: {
        selection: {
          type: 'choice',
          choice: selection,
          confidence: 1,
          probabilities: Object.fromEntries(labels.map(label => [label, label === selection ? 1 : 0])),
        },
      },
    } as never;
  },
});

const support = defineRouter({
  billing: route('Invoices, refunds, and payment questions', { queue: 'billing', priority: 2 } as const),
  account: route('Sign-in and account access problems', { queue: 'account', priority: 1 } as const),
  product: route('Questions about using the product', { queue: 'product', priority: 3 } as const),
});

const session = new DecisionSession(choose('account'));
const selected = await support.select(
  session,
  { subject: 'Locked out after changing phones' },
  'Choose the support queue that owns this request.',
);

console.log(`${selected.key}: priority ${selected.value.priority}`);
