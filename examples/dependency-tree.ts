import {
  branch,
  complete,
  runTree,
  slot,
  type DecisionProvider,
} from 'jev-code';

interface DeploymentPlan {
  readonly name: string;
  readonly steps: readonly string[];
}

const choose = (...selections: string[]): DecisionProvider => {
  return {
    async decide(_state, questions) {
      const question = Object.values(questions)[0] as { criteria: Record<string, string> };
      const labels = Object.keys(question.criteria);
      const selection = selections.find(candidate => labels.includes(candidate)) ?? labels[0]!;
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
  };
};

const database = slot<{ replicas: number }, string>({
  id: 'database',
  description: 'Database deployment mode',
  productions: [
    complete('migrate', 'Apply migrations before starting the service', () => 'migrate database'),
    complete('verify', 'Verify the existing schema without changing it', () => 'verify schema'),
  ],
});

const service = slot<{ replicas: number }, string>({
  id: 'service',
  description: 'Service rollout mode',
  productions: [
    complete('rolling', 'Replace instances gradually', ({ input }) => `roll out ${input.replicas} replicas`),
    complete('replace', 'Replace all instances together', ({ input }) => `replace ${input.replicas} replicas`),
  ],
});

const deployment = slot<{ replicas: number }, DeploymentPlan>({
  id: 'deployment',
  description: 'Validated deployment plan',
  productions: [
    branch('coordinated', 'Coordinate database and service work', { database, service }, children => ({
      name: 'coordinated deployment',
      steps: [children.database, children.service],
    })),
  ],
  validate: plan => plan.steps.length === 2 || 'A deployment needs database and service steps.',
});

const outcome = await runTree(deployment, { replicas: 3 }, {
  provider: choose('migrate', 'rolling'),
  concurrency: 2,
  limits: { decisions: 2, nodes: 16 },
});

if (outcome.status !== 'completed') throw new Error(`Tree did not complete: ${outcome.status}`);
console.log(`${outcome.value.name}: ${outcome.value.steps.join(' -> ')}`);
