import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Harness } from './harness.js';
import type { DecisionProvider, HarnessEvent, RunResult } from './types.js';

/** A scripted driver for the offline demo only. Live runs always use JevProvider. */
class DemoProvider implements DecisionProvider {
  async decide<Q extends Questions>(input: EntryType, questions: Q): Promise<SystemOneResult<Q>> {
    const state = input as { task: { turn: number }; action?: string; field?: string; generation?: { field: string; phase: string; grid?: {
      columns: number; alphabet: Array<{ key: string; value: string }>;
    } } };
    const targets: Record<string, string> = {
      path: 'hello.txt', content: 'Hello from a Jev turn loop!\n',
      command: 'test "$(cat hello.txt)" = "Hello from a Jev turn loop!" && wc -c < hello.txt',
      cwd: '.', timeout_ms: '', summary: 'Created hello.txt and verified its exact content with Bash.',
    };
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === 'noul') {
        answers[key] = { type: 'noul', noul: 1 }; continue;
      }
      if (question.type !== 'choice') throw new Error('Unexpected demo question.');
      let selected: string;
      if (!state.generation && state.field === 'timeout_ms') selected = 'default';
      else if (!state.generation) selected = ['write_file', 'bash', 'finish'][state.task.turn - 1]!;
      else if (state.generation.phase.startsWith('plan')) selected = 'free';
      else if (state.generation.phase === 'cells') {
        const grid = state.generation.grid!;
        const [, row, column] = /^cell_(\d+)_(\d+)$/.exec(key)!;
        const value = [...targets[state.generation.field]!][Number(row) * grid.columns + Number(column)] ?? '';
        selected = grid.alphabet.find(symbol => symbol.value === value)!.key;
      } else {
        const target = targets[state.generation.field]!;
        const sizes = Object.keys(question.criteria).map(key => ({ key, capacity: Number(key.slice(6)) })).sort((a, b) => a.capacity - b.capacity);
        selected = sizes.find(size => size.capacity > [...target].length)?.key ?? sizes.at(-1)!.key;
      }
      if (!Object.hasOwn(question.criteria, selected)) throw new Error(`Demo selected unavailable label: ${selected}`);
      answers[key] = { type: 'choice', choice: selected, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, label === selected ? 1 : 0])) };
    }
    return { model: 'offline-scripted-demo', usage: { input_tokens: 0, output_tokens: 0 }, answers } as unknown as SystemOneResult<Q>;
  }
}

export async function runDemo(onEvent?: (event: HarnessEvent) => void | Promise<void>): Promise<{ workspace: string; result: RunResult }> {
  const workspace = await mkdtemp(join(tmpdir(), 'jev-demo-'));
  const harness = new Harness({ experimentalGrid: true, workspace, provider: new DemoProvider(), ...(onEvent ? { onEvent } : {}) });
  const result = await harness.run('Create hello.txt containing Hello from a Jev turn loop! followed by a newline, and verify it with Bash.');
  if (result.status !== 'completed' || await readFile(join(workspace, 'hello.txt'), 'utf8') !== 'Hello from a Jev turn loop!\n') throw new Error('Offline demo failed.');
  return { workspace, result };
}
