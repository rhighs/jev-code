import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Decisions } from '../src/decisions.js';
import { generateProgram, type Dialect } from '../src/lang/core.js';
import { javascriptDialect, typescriptDialect } from '../src/lang/javascript.js';
import type { DecisionProvider } from '../src/types.js';

type Slot = { slot: string; source: string; criteria: string[] };
export type Script = (slot: Slot, seen: number) => string;

/** Answers slot by slot; a script returns the criterion key (or a literal value to look up among value_N criteria). */
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
    if (!choice) throw new Error(`No criterion ${answer} at ${state.generation.slot}; have ${keys.join(', ')}`);
    log.push(`${state.generation.slot}=${choice}`);
    return { model: 'script', usage: { input_tokens: 1, output_tokens: 1 }, answers: { selection: { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, Number(k === choice)])) } } } as unknown as SystemOneResult<Q>;
  } };
};

export const run = (dialect: Dialect, prompt: string, script: Script, maxSteps = 200): Promise<string> =>
  generateProgram(dialect, new Decisions(scripted(script), 400, new AbortController().signal), { task: { prompt } }, 'content', { maxSteps, maxBytes: 20_000, allowEmpty: false, fragments: [] });

/** A program that exercises every production: assign, function, range, if/else, while, print, return, call, compare, binary, list, index. */
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

test('the JavaScript dialect renders every production with holes marked while building', async () => {
  const previews: string[] = [];
  const dialect: Dialect = { ...javascriptDialect, render: p => { const s = javascriptDialect.render(p); previews.push(s); return s; } };
  const source = await run(dialect, 'add numbers and print the total.', fullScript);
  assert.equal(source, [
    'let total = 0;',
    'function add(a, b) {',
    '  if (b > 0) {',
    '    return b;',
    '  }',
    '  return b + 0;',
    '}',
    'for (let i = 0; i < 0; i++) {',
    '  total = 0;',
    '}',
    'while (total > 0) {',
    '  break;',
    '}',
    'console.log(add(total, 0));',
    '',
  ].join('\n'));
  assert.ok(previews.some(p => p.includes('__jev_pending__')));
  await javascriptDialect.validate(source, new AbortController().signal);
});

test('the TypeScript dialect annotates declarations and parameters', async () => {
  const source = await run(typescriptDialect, 'add numbers and print the total.', fullScript);
  assert.match(source, /^let total: number = 0;/);
  assert.match(source, /function add\(a, b\) \{/);
  await typescriptDialect.validate(source, new AbortController().signal);
  await assert.rejects(typescriptDialect.validate('let = ;', new AbortController().signal));
});

test('a custom string is composed from tokens and lists are indexed', async () => {
  const source = await run(javascriptDialect, 'Print hello.', ({ slot, criteria }, n) => {
    if (slot === 'module_body') return ['assign', 'print', 'print', 'finish'][n] ?? 'finish';
    if (slot === 'assignment_name') return 'items';
    if (slot === 'value') return 'list';
    if (slot === 'element_count') return '2';
    if (slot.startsWith('element_')) return 'number';
    if (slot === 'number') return n === 1 ? '2' : '1';
    if (slot === 'printed') return n === 0 ? 'index' : 'string';
    if (slot === 'object') return 'name';
    if (slot === 'index') return 'number';
    if (slot === 'string') return 'custom';
    if (slot.startsWith('string_token')) { const partial = JSON.parse(slot.slice('string_token:'.length)) as string; return partial === '' ? 'Print' : partial === 'Print' ? ' ' : partial === 'Print ' ? 'hello' : 'end'; }
    return criteria[0]!;
  });
  assert.equal(source, 'let items = [1, 2];\nconsole.log(items[1]);\nconsole.log("Print hello");\n');
});

test('the step budget is enforced', async () => {
  await assert.rejects(run(javascriptDialect, 'Loop.', fullScript, 3), /budget/);
});
