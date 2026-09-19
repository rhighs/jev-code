import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AstRegistry } from '../src/ast-adapters.js';
import { proposeTool } from '../src/propose/tool.js';
import { completionSummary } from '../src/summary.js';
import type { Completion, ProposalProvider, ProposalRequest } from '../src/providers/types.js';
import { autoApproved } from '../src/tools.js';
import type { ToolContext } from '../src/types.js';

const registry = new AstRegistry();
const AE1 = ['def f():\n  return 1\n', 'def f(:\n', 'def f():\n  return 2\n'];
type Select = NonNullable<ToolContext['select']>;
interface Seen { instruction: string; criteria: Record<string, string>; extra: Record<string, unknown> }

const fake = (texts: string[] | Error): ProposalProvider & { calls: ProposalRequest[] } => {
  const calls: ProposalRequest[] = [];
  return {
    id: 'fake', model: 'tiny', calls,
    async generate(req: ProposalRequest): Promise<Completion[]> {
      calls.push(req);
      if (texts instanceof Error) throw texts;
      return texts.map(text => ({ text, truncated: false }));
    },
  };
};

async function setup(t: test.TestContext, choice = 'C', confidence = 0.81) {
  const ws = await mkdtemp(join(tmpdir(), 'jev-propose-'));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const seen: Seen[] = [];
  const select: Select = async (instruction, criteria, extra) => { seen.push({ instruction, criteria, extra }); return { choice, confidence }; };
  const ctrl = new AbortController();
  const ctx: ToolContext = { workspace: ws, signal: ctrl.signal, resolvePath: async p => join(ws, p), select, proposals: { used: 0, max: 20 } };
  return { ws, ctx, ctrl, seen };
}

test('propose is a confirmable write tool', () => {
  const tool = proposeTool(fake(AE1), registry);
  assert.equal(tool.name, 'propose');
  assert.equal(tool.effect, 'write');
  assert.equal(autoApproved(tool, true), false);
  assert.equal(autoApproved(tool, false), true);
  assert.deepEqual(Object.keys(tool.fields), ['kind', 'objective', 'constraints', 'count', 'path']);
  assert.deepEqual(tool.fields.count, { type: 'number', min: 1, max: 5, default: 3, description: tool.fields.count!.description });
});

test('propose writes the selected file candidate and reports every candidate', async t => {
  const { ws, ctx, seen } = await setup(t);
  await writeFile(join(ws, 'x.py'), 'def f():\n  return 0\n');
  const provider = fake(AE1);
  const res = await proposeTool(provider, registry).execute({ kind: 'file', objective: 'return two', constraints: '', count: 3, path: 'x.py' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(await readFile(join(ws, 'x.py'), 'utf8'), AE1[2]);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]!.current, 'def f():\n  return 0\n');
  assert.equal(provider.calls[0]!.path, 'x.py');
  assert.equal(ctx.proposals!.used, 1);
  const lines = res.output.split('\n');
  assert.equal(lines[0], 'provider=fake model=tiny');
  assert.equal(lines[1], 'A valid 20 bytes');
  assert.match(lines[2]!, /^B invalid: .*SyntaxError/);
  assert.equal(lines[3], 'C valid 20 bytes');
  assert.equal(lines[4], 'selected C 0.81');
  assert.equal(lines[5], 'Wrote 20 bytes to x.py:');
  assert.ok(res.output.endsWith(`\n\n${AE1[2]}`));
  assert.equal(res.data?.selected, 'C');
  assert.equal(res.data?.confidence, 0.81);
  assert.equal(res.data?.provider, 'fake');
  assert.equal(res.data?.model, 'tiny');
  assert.equal(res.data?.kind, 'file');
  assert.equal(res.data?.path, 'x.py');
  const cands = res.data?.candidates as Array<Record<string, unknown>>;
  assert.equal(cands[1]!.valid, false);
  assert.equal(cands[0]!.valid, true);
  assert.equal(cands[0]!.reason, undefined);
  assert.ok(!('text' in cands[0]!));
  assert.ok(Array.isArray(res.data?.hunk));
  assert.ok((res.data?.hunk as unknown[]).length > 0);
  assert.equal(seen.length, 1);
  const { instruction, criteria, extra } = seen[0]!;
  assert.match(instruction, /Select the candidate/);
  assert.deepEqual(Object.keys(criteria), ['A', 'C', 'reject']);
  assert.notEqual(criteria.A, criteria.C);
  assert.match(criteria.A!, /return 1/);
  assert.match(criteria.C!, /return 2/);
  assert.match(criteria.A!, /^\+1\/-1 /);
  assert.ok(Object.values(criteria).every(c => c.length <= 80));
  assert.equal(extra.field, 'candidate');
  assert.deepEqual(extra.generation, { phase: 'propose', slot: 'select' });
  const entries = extra.candidates as Array<Record<string, unknown>>;
  assert.deepEqual(entries.map(e => e.label), ['A', 'B', 'C']);
  assert.ok(entries.every(e => !('text' in e)));
  assert.ok(entries.every(e => e.preview === undefined || (e.preview as string).length <= 4096));
  assert.match(entries[0]!.preview as string, /-  return 0/);
  assert.match(entries[0]!.preview as string, /\+  return 1/);
  assert.match(entries[2]!.preview as string, /\+  return 2/);
  assert.match(entries[1]!.reason as string, /SyntaxError/);
});

test('propose clips previews of large candidates to 4 KB', async t => {
  const { ctx, seen } = await setup(t, 'A');
  const big = Array.from({ length: 600 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n';
  const res = await proposeTool(fake([big]), registry).execute({ kind: 'file', objective: 'o', constraints: '', count: 1, path: 'new.py' }, ctx);
  assert.equal(res.ok, true);
  assert.ok(big.length > 4096);
  const entries = seen[0]!.extra.candidates as Array<{ preview: string }>;
  assert.equal(entries[0]!.preview.length, 4096);
  assert.ok((res.data?.hunk as unknown[]).length <= 120);
  assert.deepEqual(Object.keys(seen[0]!.criteria), ['A', 'reject']);
  assert.equal(seen[0]!.criteria.A, 'x0 = 0');
});

test('propose reject leaves the file alone and reports rejected all', async t => {
  const { ws, ctx, seen } = await setup(t, 'reject', 0.6);
  await writeFile(join(ws, 'x.py'), 'def f():\n  return 0\n');
  const res = await proposeTool(fake(AE1), registry).execute({ kind: 'file', objective: 'o', constraints: '', count: 3, path: 'x.py' }, ctx);
  assert.equal(res.ok, false);
  assert.equal(await readFile(join(ws, 'x.py'), 'utf8'), 'def f():\n  return 0\n');
  assert.ok(res.output.endsWith('\nrejected all'));
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.criteria.reject!, /No candidate is acceptable/);
  assert.equal(res.data?.selected, undefined);
  assert.equal(res.data?.hunk, undefined);
});

test('propose with no valid candidate never asks the host', async t => {
  const { ctx, seen } = await setup(t);
  const res = await proposeTool(fake(['def f(:\n', '', '```\n```\n']), registry).execute({ kind: 'file', objective: 'o', constraints: '', count: 3, path: 'x.py' }, ctx);
  assert.equal(res.ok, false);
  assert.equal(seen.length, 0);
  assert.ok(res.output.endsWith('\nno valid candidate'));
  assert.match(res.output, /^B invalid: empty$/m);
  assert.match(res.output, /^C invalid: empty$/m);
});

test('a failing provider marks every candidate as a generation failure', async t => {
  const { ctx, seen } = await setup(t);
  const res = await proposeTool(fake(new Error('rate limited')), registry).execute({ kind: 'file', objective: 'o', constraints: '', count: 3, path: 'x.py' }, ctx);
  assert.equal(res.ok, false);
  assert.equal(seen.length, 0);
  assert.equal(ctx.proposals!.used, 1);
  const cands = res.data?.candidates as Array<Record<string, unknown>>;
  assert.equal(cands.length, 3);
  assert.ok(cands.every(c => c.reason === 'generation failed: rate limited'));
  assert.match(res.output, /^A invalid: generation failed: rate limited$/m);
});

test('propose text returns the selected text without touching the workspace', async t => {
  const { ctx, seen } = await setup(t, 'B', 0.5);
  const provider = fake(['first\n', 'second\n']);
  const res = await proposeTool(provider, registry).execute({ kind: 'text', objective: 'o', constraints: 'short', count: 2, path: '' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(provider.calls[0]!.path, undefined);
  assert.equal(provider.calls[0]!.current, undefined);
  assert.ok(res.output.endsWith('selected B 0.50\n\nsecond\n'));
  assert.equal(res.data?.hunk, undefined);
  assert.equal(res.data?.path, undefined);
  assert.equal(res.data?.selected, 'B');
  const entries = seen[0]!.extra.candidates as Array<{ preview: string }>;
  assert.equal(entries[1]!.preview, 'second\n');
  assert.equal(seen[0]!.criteria.B, 'second');
});

test('propose rejects a file request without a path before generating', async t => {
  const { ctx } = await setup(t);
  const provider = fake(AE1);
  await assert.rejects(proposeTool(provider, registry).execute({ kind: 'file', objective: 'o', constraints: '', count: 3, path: '' }, ctx), /path is required for file candidates/);
  assert.equal(provider.calls.length, 0);
  assert.equal(ctx.proposals!.used, 0);
});

test('propose needs a host that can select', async t => {
  const { ctx } = await setup(t);
  const provider = fake(AE1);
  const { select: _select, ...bare } = ctx;
  await assert.rejects(proposeTool(provider, registry).execute({ kind: 'text', objective: 'o', constraints: '', count: 1, path: '' }, bare), /propose needs a host that can select/);
  assert.equal(provider.calls.length, 0);
});

test('an exhausted proposal budget skips the provider and names the fallback tools', async t => {
  const { ctx } = await setup(t);
  ctx.proposals = { used: 20, max: 20 };
  const provider = fake(AE1);
  const res = await proposeTool(provider, registry).execute({ kind: 'text', objective: 'o', constraints: '', count: 1, path: '' }, ctx);
  assert.equal(res.ok, false);
  assert.equal(res.output, 'proposal budget exhausted; use write_file or edit_file');
  assert.equal(provider.calls.length, 0);
  assert.equal(ctx.proposals.used, 20);
});

test('propose stops after generation when the run is aborted', async t => {
  const { ws, ctx, ctrl, seen } = await setup(t);
  const provider: ProposalProvider = { id: 'fake', model: 'tiny', async generate() { ctrl.abort(); return AE1.map(text => ({ text, truncated: false })); } };
  await assert.rejects(proposeTool(provider, registry).execute({ kind: 'file', objective: 'o', constraints: '', count: 3, path: 'x.py' }, ctx), (err: Error) => err.name === 'AbortError');
  assert.equal(seen.length, 0);
  await assert.rejects(readFile(join(ws, 'x.py')), { code: 'ENOENT' });
});

test('propose text with a path reads the file as context and leaves it unchanged', async t => {
  const { ws, ctx, seen } = await setup(t, 'A', 0.9);
  await writeFile(join(ws, 'x.py'), 'def f():\n  return 0\n');
  const provider = fake(['It defines f, which returns 0.\n']);
  const res = await proposeTool(provider, registry).execute({ kind: 'text', objective: 'what does x.py do?', constraints: '', count: 1, path: 'x.py' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(provider.calls[0]!.path, 'x.py');
  assert.equal(provider.calls[0]!.current, 'def f():\n  return 0\n');
  assert.equal(await readFile(join(ws, 'x.py'), 'utf8'), 'def f():\n  return 0\n');
  assert.ok(res.output.endsWith('selected A 0.90\n\nIt defines f, which returns 0.\n'));
  assert.equal(res.data?.hunk, undefined);
  const entries = seen[0]!.extra.candidates as Array<{ preview: string }>;
  assert.equal(entries[0]!.preview, 'It defines f, which returns 0.\n');
});

test('the completion summary quotes a text proposal and names a written file', async t => {
  const { ws, ctx } = await setup(t, 'A', 0.9);
  await writeFile(join(ws, 'x.py'), 'def f():\n  return 0\n');
  const tool = proposeTool(fake(['It defines f.\n']), registry);
  const text = await tool.execute({ kind: 'text', objective: 'what does x.py do?', constraints: '', count: 1, path: 'x.py' }, ctx);
  const file = await proposeTool(fake(['def f():\n  return 1\n']), registry).execute({ kind: 'file', objective: 'return one', constraints: '', count: 1, path: 'x.py' }, ctx);
  assert.equal(completionSummary([
    { turn: 1, tool: 'propose', args: { kind: 'text', path: 'x.py' }, result: text },
    { turn: 2, tool: 'propose', args: { kind: 'file', path: 'x.py' }, result: file },
  ]), 'It defines f.\nWrote x.py from proposal A.');
});
