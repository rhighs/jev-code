import {
  branch,
  complete,
  runTree,
  slot,
  type ProgramRunOutcome,
} from 'jev-code';

const leaf = slot<void, number>({
  id: 'leaf',
  description: 'A number',
  productions: [complete('one', 'The number one', () => 1)],
});
const root = slot<void, { value: number }>({
  id: 'root',
  description: 'A wrapped number',
  productions: [branch('wrap', 'Wrap the number', { value: leaf }, children => children)],
});

const outcome: Promise<ProgramRunOutcome<{ value: number }>> = runTree(root, undefined);
void outcome;
