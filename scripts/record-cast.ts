#!/usr/bin/env node
/**
 * Fallback recorder for docs/media/session.cast (non-shipped; scripts/ is outside the package
 * `files` list and the test glob). It drives the real `Harness`/`printRun` pipeline against a
 * local scripted provider, so the recording can be regenerated without an API key when a live
 * run is unavailable. The README caption must state that this provider produced the recording.
 *
 *   pnpm run build   # not required for this script; tsx reads src/ directly
 *   asciinema rec docs/media/session.cast --overwrite -i 1 --cols 100 --rows 30 \
 *     -c "node_modules/.bin/tsx scripts/record-cast.ts"
 *   agg --theme github-dark --idle-time-limit 1 --speed 1.5 --fps-cap 20 \
 *     docs/media/session.cast docs/media/session.gif
 *
 * The scripted run mirrors the live demo: write hello.py through the Python AST builder, run it
 * with python3, then finish. It answers the same question shapes the harness sends; anything
 * outside the script fails loudly instead of producing a misleading recording.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { printRun } from '../src/print.js';
import type { DecisionProvider } from '../src/types.js';

const TASK = 'create hello.py that prints Hello, world! and run it with python3';
/** One action per turn: write the file, run it, finish. */
const ACTIONS = ['write_file', 'bash', 'finish'];
/** AST productions for print('Hello, world!'), the same sequence the live run chose. */
const PYTHON_SCRIPT: Array<string | { value: string }> = ['0', 'expr', 'call', { value: 'print' }, '1', 'string', { value: JSON.stringify('Hello, world!') }, 'finish'];

interface RecordedState {
  task: { turn: number };
  field?: string;
  completionCheck?: boolean;
  generation?: { phase?: string; slot?: string };
}

const choiceAnswer = (label: string, labels: string[]): unknown => ({
  type: 'choice', choice: label, confidence: 1,
  probabilities: Object.fromEntries(labels.map(candidate => [candidate, candidate === label ? 1 : 0])),
});

class RecordedProvider implements DecisionProvider {
  private readonly python = [...PYTHON_SCRIPT];
  constructor(private readonly actions: string[] = ACTIONS) {}

  async decide<Q extends Questions>(input: EntryType, questions: Q, _signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    const state = (input ?? {}) as unknown as RecordedState;
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type !== 'choice') throw new Error(`recorder: expected a choice question for ${key}`);
      const labels = Object.keys(question.criteria);
      answers[key] = choiceAnswer(this.select(state, labels, question.criteria, key), labels);
    }
    return { model: 'scripted-recorder', usage: { input_tokens: 10, output_tokens: 2 }, answers } as unknown as SystemOneResult<Q>;
  }

  private select(state: RecordedState, labels: string[], criteria: Record<string, unknown>, key: string): string {
    if (state.generation?.phase === 'ast') {
      const desired = this.python.shift();
      if (desired === undefined) throw new Error(`recorder: no scripted AST decision for ${state.generation.slot ?? key}`);
      const label = typeof desired === 'string' ? desired
        : labels.find(candidate => criteria[candidate] === desired.value || criteria[candidate] === JSON.stringify(desired.value));
      if (label === undefined || !labels.includes(label)) throw new Error(`recorder: production ${JSON.stringify(desired)} is not offered for ${state.generation.slot ?? key}`);
      return label;
    }
    if (state.completionCheck) return this.require(labels, ['complete'], 'completion check');
    if (state.generation?.phase === 'bash_ast') {
      // The composed plan that runs the file just written, else the first offered whole-command plan.
      const plan = labels.find(label => /hello\.py/.test(String(criteria[label] ?? ''))) ?? labels.find(label => label === 'plan_0');
      if (plan === undefined) throw new Error('recorder: no Bash plan that runs hello.py');
      return plan;
    }
    if (state.field !== undefined) return this.require(labels, ['plan_0', 'default'], `field ${state.field}`);
    const action = this.actions[state.task.turn - 1];
    if (action === undefined || !labels.includes(action)) throw new Error(`recorder: no scripted action for turn ${state.task.turn}`);
    return action;
  }

  private require(labels: string[], candidates: string[], where: string): string {
    const found = candidates.find(candidate => labels.includes(candidate));
    if (found === undefined) throw new Error(`recorder: no scripted answer for ${where} in [${labels.join(', ')}]`);
    return found;
  }
}

const workspace = await mkdtemp(join(tmpdir(), 'jev-cast-'));
try {
  const result = await printRun({
    harness: { workspace, provider: new RecordedProvider() },
    prompt: TASK,
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
    yes: true, confirmWrites: false, json: false,
    signal: new AbortController().signal,
  });
  process.exitCode = result.status === 'completed' ? 0 : 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
