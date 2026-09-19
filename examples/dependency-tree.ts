import {
  branch,
  complete,
  runTree,
  slot,
  type DecisionProvider,
} from 'jev-code';

interface FamilyTree {
  readonly name: string;
  readonly children: readonly FamilyTree[];
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

const names = ['Oak', 'Birch', 'Cedar', 'Elm', 'Ash', 'Pine'];
const family = (index: number, generation: number): ReturnType<typeof slot<{ generations: number }, FamilyTree>> => slot({
  id: `person-${index}-${generation}`,
  description: `Family member in generation ${generation}`,
  productions: [
    complete('leaf', 'Record this person without descendants', () => ({ name: names[index % names.length]!, children: [] })),
    branch('descendants', 'Add two descendants', ({ input }) => ({
      first: family(index * 2 + 1, generation + 1),
      second: family(index * 2 + 2, generation + 1),
    }), children => ({ name: names[index % names.length]!, children: [children.first, children.second] }),
    input => generation < input.generations),
  ],
  validate: person => person.name.length > 0 && (person.children.length === 0 || person.children.length === 2)
    || 'Every family member must have a name and either zero or two children.',
});

const outcome = await runTree(family(0, 0), { generations: 2 }, {
  provider: choose('descendants'),
  concurrency: 2,
  maxDepth: 3,
  limits: { decisions: 3, nodes: 64 },
  validate: tree => tree.children.length === 2 || 'The root must include descendants.',
});

if (outcome.status !== 'completed') throw new Error(`Tree did not complete: ${outcome.status}`);
console.log(JSON.stringify(outcome.value));
