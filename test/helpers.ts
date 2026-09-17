import assert from 'node:assert/strict';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import type { DecisionProvider } from '../src/types.js';

export interface Step { action: string; args?: Record<string, string>; verdict?: number; allowInvalidSyntax?: boolean }
export interface TestState {
  task: { turn: number; prompt: string; updates: string[] };
  generation?: { field: string; phase: string; syntax?: unknown[]; draft?: string; tokens?: Array<{ key: string; value: string }>; grid?: { columns: number; capacity: number; alphabet: Array<{ key: string; value: string }> } };
  field?: string;
  completionCheck?: boolean;
  recent: Array<{ tool: string; result: { ok: boolean; output: string } }>;
}

export class ScriptedProvider implements DecisionProvider {
  states: TestState[] = [];
  constructor(private readonly steps: Step[], private readonly inspect?: (state: TestState) => void) {}
  async decide<Q extends Questions>(input: EntryType, questions: Q, _signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    const state = input as unknown as TestState;
    this.states.push(structuredClone(state));
    this.inspect?.(state);
    const step = this.steps[state.task.turn - 1];
    assert.ok(step, `No scripted step for turn ${state.task.turn}`);
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type === 'noul') {
        const score = state.generation ? (state.generation.syntax ? Number(step.allowInvalidSyntax ?? false) : 1) : step.verdict ?? 1;
        answers[key] = { type: 'noul', noul: score };
        continue;
      }
      assert.equal(question.type, 'choice');
      if (question.type !== 'choice') throw new Error('Only Choice and Noul are used.');
      let selected = step.action;
      if (state.completionCheck) selected = (step.verdict ?? 1) >= 0.5 ? 'complete' : 'continue';
      if (state.generation?.phase.startsWith('plan')) selected = 'free';
      if (state.generation?.phase === 'bash_ast') {
        const target = step.args?.[state.generation.field];
        selected = Object.entries(question.criteria).find(([, value]) => typeof value === 'string' && value.replace(/'/g, '') === target)?.[0] ?? 'unavailable-command';
      }
      if (state.generation?.phase === 'tokens') {
        const target = step.args?.[state.generation.field];
        assert.notEqual(target, undefined, `Missing scripted argument ${state.generation.field}`);
        const draft = state.generation.draft ?? '';
        assert.ok(target!.startsWith(draft));
        const remainder = target!.slice(draft.length);
        const token = state.generation.tokens!.filter(token => remainder.startsWith(token.value)).sort((a, b) => b.value.length - a.value.length)[0];
        selected = remainder ? token?.key ?? 'unavailable-token' : 'END';
      }
      if (state.generation?.phase === 'cells') {
        const grid = state.generation.grid!;
        const [, row, column] = /^cell_(\d+)_(\d+)$/.exec(key)!;
        const target = step.args?.[state.generation.field];
        assert.notEqual(target, undefined, `Missing scripted argument ${state.generation.field}`);
        const value = [...target!][Number(row) * grid.columns + Number(column)] ?? '';
        const symbol = grid.alphabet.find(symbol => symbol.value === value);
        assert.ok(symbol, `No alphabet symbol for ${JSON.stringify(value)}`);
        selected = symbol.key;
      }
      if (!state.generation && state.field && Object.hasOwn(question.criteria, 'default')) {
        const value = step.args?.[state.field];
        selected = value ? `number_${value}` : 'default';
      }
      if (state.generation?.phase === 'shape') {
        const target = step.args?.[state.generation.field];
        assert.notEqual(target, undefined, `Missing scripted argument ${state.generation.field}`);
        const capacities = Object.keys(question.criteria).map(key => ({ key, capacity: Number(key.slice(6)) })).sort((a, b) => a.capacity - b.capacity);
        selected = capacities.find(candidate => candidate.capacity > [...target!].length)?.key ?? capacities.at(-1)!.key;
      }
      assert.ok(Object.hasOwn(question.criteria, selected), `Unavailable choice ${selected}`);
      answers[key] = { type: 'choice', choice: selected, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, label === selected ? 1 : 0])) };
    }
    return { model: 'scripted-test', usage: { input_tokens: 10, output_tokens: 2 }, answers } as unknown as SystemOneResult<Q>;
  }
}
