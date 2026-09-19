import assert from 'node:assert/strict';
import type { EntryType, Question, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import type { DecisionProvider } from '../src/types.js';

export type SlotAnswer = string | { value: string } | { score: number } | { noul: number };
export interface SlotEntry { phase?: string; slot?: string | RegExp; unit?: string; candidate?: number; answer: SlotAnswer; once?: boolean }
interface SlotState { generation?: { phase?: string; slot?: string; unit?: string; candidate?: number } }

const full = (labels: string[], hit: string | number): Record<string, number> => Object.fromEntries(labels.map(label => [label, String(label) === String(hit) ? 1 : 0]));

export class SlotProvider implements DecisionProvider {
  states: SlotState[] = [];
  calls = 0;
  private readonly used = new Set<SlotEntry>();
  constructor(private readonly script: SlotEntry[]) {}

  private match(state: SlotState, key: string): SlotEntry | undefined {
    const gen = state.generation;
    const slot = gen?.slot ?? key;
    return this.script.find(entry => !this.used.has(entry) &&
      (entry.phase === undefined || entry.phase === gen?.phase) &&
      (entry.unit === undefined || entry.unit === gen?.unit) &&
      (entry.candidate === undefined || entry.candidate === gen?.candidate) &&
      (entry.slot === undefined || (typeof entry.slot === 'string' ? entry.slot === slot : entry.slot.test(slot))));
  }

  private answer(entry: SlotEntry | undefined, question: Question, where: string): unknown {
    const answer = entry?.answer;
    if (question.type === 'noul') return { type: 'noul', noul: typeof answer === 'object' && 'noul' in answer ? answer.noul : 1 };
    if (!entry) throw new Error(`SlotProvider: no entry for ${where}`);
    if (question.type === 'score') {
      if (typeof answer !== 'object' || !('score' in answer)) throw new Error(`SlotProvider: ${where} needs a score answer`);
      const levels = question.criteria.map((_, i) => String(i));
      if (!levels.includes(String(answer.score))) throw new Error(`SlotProvider: ${where} score ${answer.score} outside rubric`);
      return { type: 'score', score: answer.score, confidence: 1, probabilities: full(levels, answer.score), legend: Object.fromEntries(question.criteria.map((desc, i) => [String(i), desc])) };
    }
    const labels = Object.keys(question.criteria);
    let selected: string | undefined;
    if (typeof answer === 'string') selected = answer;
    else if (typeof answer === 'object' && 'value' in answer) {
      const { value } = answer;
      selected = labels.find(label => question.criteria[label] === JSON.stringify(value) || question.criteria[label] === value);
    }
    if (selected === undefined || !labels.includes(selected)) throw new Error(`SlotProvider: ${where} answer ${JSON.stringify(answer)} not in criteria [${labels.join(', ')}]`);
    return { type: 'choice', choice: selected, confidence: 1, probabilities: full(labels, selected) };
  }

  async decide<Q extends Questions>(input: EntryType, questions: Q, _signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    const state = (input ?? {}) as SlotState;
    this.states.push(structuredClone(state));
    this.calls++;
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(questions)) {
      const entry = this.match(state, key);
      const where = `phase=${state.generation?.phase ?? 'none'} slot=${state.generation?.slot ?? key}${state.generation?.unit ? ` unit=${state.generation.unit}` : ''}`;
      answers[key] = this.answer(entry, question, where);
      if (entry?.once) this.used.add(entry);
    }
    return { model: 'slot-provider', usage: { input_tokens: 1, output_tokens: 0 }, answers } as unknown as SystemOneResult<Q>;
  }
}

export interface Step { action: string; args?: Record<string, string>; verdict?: number; allowInvalidSyntax?: boolean; candidate?: string }
export interface TestState {
  task: { turn: number; prompt: string; updates: string[] };
  generation?: { field: string; phase: string; syntax?: unknown[]; draft?: string; tokens?: Array<{ key: string; value: string }>; grid?: { columns: number; capacity: number; alphabet: Array<{ key: string; value: string }> } };
  field?: string;
  completionCheck?: boolean;
  recent: Array<{ tool: string; result: { ok: boolean; output: string } }>;
}

export class ScriptedProvider implements DecisionProvider {
  states: TestState[] = [];
  actions: Array<{ turn: number; offered: string[] }> = [];
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
      if (!state.generation && !state.completionCheck && !state.field) this.actions.push({ turn: state.task.turn, offered: Object.keys(question.criteria) });
      if (state.completionCheck) selected = (step.verdict ?? 1) >= 0.5 ? 'complete' : 'continue';
      if (state.generation?.phase.startsWith('plan')) selected = 'free';
      if (state.generation?.phase === 'propose') selected = step.candidate ?? 'reject';
      if (!state.generation && state.field && !state.completionCheck && !Object.hasOwn(question.criteria, 'default') && !Object.hasOwn(question.criteria, 'custom')) {
        const value = step.args?.[state.field];
        if (value !== undefined && Object.hasOwn(question.criteria, value)) selected = value;
      }
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
        const tokens = Object.entries(question.criteria).filter(([key]) => key !== 'END').map(([key, value]) => ({ key, value: JSON.parse(String(value)) as string }));
        const token = tokens.filter(token => remainder.startsWith(token.value)).sort((a, b) => b.value.length - a.value.length)[0];
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
