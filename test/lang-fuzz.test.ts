import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import type { EntryType, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { Decisions } from '../src/decisions.js';
import { generateProgram, type Dialect } from '../src/lang/core.js';
import { cDialect } from '../src/lang/c.js';
import { goDialect } from '../src/lang/go.js';
import { javascriptDialect, typescriptDialect } from '../src/lang/javascript.js';
import { luaDialect } from '../src/lang/lua.js';
import { rubyDialect } from '../src/lang/ruby.js';
import { rustDialect } from '../src/lang/rust.js';
import type { DecisionProvider } from '../src/types.js';

const exec = promisify(execFile);
const ROUNDS = Number(process.env.JEV_FUZZ_ROUNDS ?? 12);

const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

const random = (seed: number): DecisionProvider => {
  const next = rng(seed);
  return { decide: async <Q extends Questions>(input: EntryType, questions: Q) => {
    const q = questions.selection;
    if (!q || q.type !== 'choice') throw new Error('Expected a choice question.');
    const state = input as { generation: { slot: string; partialSource: string; constraints: { depth: number } } };
    const keys = Object.keys(q.criteria);
    const slot = state.generation.slot;
    let pool = keys;
    if (slot === 'module_body' || slot.endsWith('_body')) {
      const lines = state.generation.partialSource.split('\n').length;
      if (lines > 40 && keys.includes('finish')) pool = ['finish'];
      else if (lines > 14) pool = keys.filter(k => ['print', 'assign', 'return', 'finish', 'break', 'expr'].includes(k));
    }
    if (slot === 'string') pool = keys.filter(k => k !== 'custom');
    if (slot.startsWith('string_token')) pool = ['end'];
    if (state.generation.constraints.depth >= 3) pool = pool.filter(k => !['binary', 'compare', 'call', 'list', 'index', 'concat'].includes(k)) ;
    if (!pool.length) pool = keys;
    const choice = pool[Math.floor(next() * pool.length)]!;
    return { model: 'fuzz', usage: { input_tokens: 1, output_tokens: 1 }, answers: { selection: { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, Number(k === choice)])) } } } as unknown as SystemOneResult<Q>;
  } };
};

const has = async (bin: string): Promise<boolean> => exec('which', [bin]).then(() => true, () => false);

const DIALECTS: Array<{ dialect: Dialect; bin: string }> = [
  { dialect: javascriptDialect, bin: 'node' }, { dialect: typescriptDialect, bin: 'node' }, { dialect: cDialect, bin: 'gcc' },
  { dialect: rustDialect, bin: 'rustc' }, { dialect: goDialect, bin: 'go' }, { dialect: luaDialect, bin: 'luac' }, { dialect: rubyDialect, bin: 'ruby' },
];

for (const { dialect, bin } of DIALECTS) {
  test(`${dialect.name}: ${ROUNDS} random programs render and pass ${bin}`, { timeout: 600_000 }, async t => {
    if (!await has(bin)) return t.skip(`${bin} missing`);
    const failures: string[] = [];
    let built = 0;
    for (let seed = 1; seed <= ROUNDS; seed++) {
      let source: string;
      try {
        source = await generateProgram(dialect, new Decisions(random(seed * 7919), 2000, new AbortController().signal), { task: { prompt: 'count items and print the total message' } }, 'content', { maxSteps: 400, maxBytes: 60_000, allowEmpty: false, fragments: [] });
      } catch (err) {
        if (/budget|exhausted/.test(String(err))) continue;
        failures.push(`seed ${seed} generate: ${String(err).split('\n')[0]}`);
        continue;
      }
      built++;
      assert.equal(source.includes('__jev_pending__'), false, `seed ${seed} left a hole:\n${source}`);
      try { await dialect.validate(source, new AbortController().signal); }
      catch (err) { failures.push(`seed ${seed}:\n${source}\n--> ${String(err).split('\n').slice(0, 4).join('\n')}`); }
    }
    assert.ok(built >= Math.min(3, ROUNDS), `only ${built} programs were built`);
    assert.deepEqual(failures, [], failures.join('\n\n'));
  });
}
