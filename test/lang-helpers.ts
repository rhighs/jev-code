import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Decisions } from '../src/decisions.js';
import { generateProgram, type Dialect } from '../src/lang/core.js';
import type { DecisionProvider } from '../src/types.js';

export type Slot = { slot: string; source: string; criteria: string[] };
export type Script = (slot: Slot, seen: number) => string;

export const scripted = (script: Script, log: string[] = []): DecisionProvider => {
  const seen = new Map<string, number>();
  return { decide: async <Q extends Questions>(input: EntryType, questions: Q) => {
    const q = questions.selection;
    if (!q || q.type !== 'choice') throw new Error('Expected a choice question.');
    const state = input as { generation: { slot: string; partialSource: string } };
    const keys = Object.keys(q.criteria);
    const n = seen.get(state.generation.slot) ?? 0;
    seen.set(state.generation.slot, n + 1);
    const answer = script({ slot: state.generation.slot, source: state.generation.partialSource, criteria: keys }, n);
    const choice = keys.includes(answer) ? answer : keys.find(k => q.criteria[k] === JSON.stringify(answer) || q.criteria[k] === answer);
    if (!choice) throw new Error(`No criterion ${answer} at ${state.generation.slot}; have ${keys.map(k => `${k}=${q.criteria[k]}`).join(', ')}`);
    log.push(`${state.generation.slot}=${choice}`);
    return { model: 'script', usage: { input_tokens: 1, output_tokens: 1 }, answers: { selection: { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, Number(k === choice)])) } } } as unknown as SystemOneResult<Q>;
  } };
};

export const run = (dialect: Dialect, prompt: string, script: Script, maxSteps = 200): Promise<string> =>
  generateProgram(dialect, new Decisions(scripted(script), 400, new AbortController().signal), { task: { prompt } }, 'content', { maxSteps, maxBytes: 20_000, allowEmpty: false, fragments: [] });

export const fullScript: Script = ({ slot, criteria }, n) => {
  switch (slot) {
    case 'module_body': return ['assign', 'function', 'range', 'while', 'print', 'finish'][n] ?? 'finish';
    case 'assignment_target': return criteria.includes('name_0') ? 'name_0' : 'new';
    case 'assignment_name': return 'total';
    case 'value': return 'number';
    case 'number': return '0';
    case 'function_name': return 'add';
    case 'parameter_count': return '2';
    case 'parameter_0': return 'a';
    case 'parameter_1': return 'b';
    case 'function_body': return n === 0 ? 'if' : 'return';
    case 'condition': return 'compare';
    case 'operator': return criteria.includes('gt') ? 'gt' : 'add';
    case 'left': return 'name';
    case 'right': return 'number';
    case 'reference': return criteria.length > 1 ? criteria[criteria.length - 1]! : criteria[0]!;
    case 'if_body': return n === 0 ? 'return' : 'finish';
    case 'returned': return n === 0 ? 'name' : 'binary';
    case 'else_branch': return 'no';
    case 'loop_variable': return 'i';
    case 'start': return 'number';
    case 'stop': return 'number';
    case 'loop_body': return n === 0 ? 'assign' : n === 1 ? 'finish' : n === 2 ? 'break' : 'finish';
    case 'printed': return n === 0 ? 'call' : 'string';
    case 'callee': return criteria[criteria.length - 1]!;
    case 'argument_0': return 'name';
    case 'argument_1': return 'number';
    case 'string': return 'custom';
    case 'singleton': return 'true';
    default: if (slot.startsWith('string_token')) return slot.endsWith(':""') ? 'piece_0' : 'end'; return criteria[0]!;
  }
};
