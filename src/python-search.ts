import type { Decisions } from './decisions.js';
import type { PythonNode } from './python-ast.js';
import type { Unit } from './python-units.js';

export const RUBRIC = ['does not address the purpose', 'partially addresses the purpose', 'correct but includes unneeded behavior', 'correct and minimal'];
export interface Candidate { index: number; body: PythonNode[]; source: string; kept: boolean; reason?: string; expected?: number }
export interface SearchHooks {
  width: number;
  generate(fork: Decisions, body: PythonNode[], candidate: number): Promise<void>;
  render(body: PythonNode[]): Promise<string>;
  check(source: string): Promise<string | undefined>;
  score(decisions: Decisions, source: string, candidate: number): Promise<number>;
  report(candidate: Candidate): Promise<void>;
}

export const wantsReturn = (purpose: string): boolean => /\b(?:returns?|compute|calculate|get|read|sum|count|total|check|parse|build|make|create|convert)\b/i.test(purpose);

/** K candidates from independent forks; static pruning first, Jev score second; ties keep the first. */
export async function searchUnit(unit: Unit, decisions: Decisions, hooks: SearchHooks): Promise<void> {
  const controller = new AbortController();
  const bodies = Array.from({ length: hooks.width }, () => [] as PythonNode[]);
  const outcomes = await Promise.allSettled(bodies.map(async (body, i) => {
    try { await hooks.generate(decisions.fork(controller.signal), body, i); } catch (err) { controller.abort(err); throw err; }
  }));
  const failure = outcomes.find(o => o.status === 'rejected');
  if (failure?.status === 'rejected') throw controller.signal.reason ?? failure.reason;
  const candidates: Candidate[] = [];
  for (const [index, body] of bodies.entries()) {
    const source = await hooks.render(body);
    const reason = await hooks.check(source);
    candidates.push({ index, body, source, kept: false, ...(reason === undefined ? {} : { reason }) });
  }
  const survivors = candidates.filter(c => c.reason === undefined);
  await Promise.all(survivors.map(async c => { c.expected = await hooks.score(decisions, c.source, c.index); }));
  const best = survivors.reduce<Candidate | undefined>((acc, c) => acc === undefined || c.expected! > acc.expected! ? c : acc, undefined);
  if (best) best.kept = true;
  for (const c of candidates) await hooks.report(c);
  if (!best) throw new Error(`Unit ${unit.name}: every search candidate was dropped (${candidates.map(c => c.reason).join(', ')}).`);
  unit.body.splice(0, unit.body.length, ...best.body);
}
