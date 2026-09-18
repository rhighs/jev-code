import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runPython, type CheckResult } from '../../src/eval.js';

export default async function check(workspace: string): Promise<CheckResult> {
  if (!(await stat(join(workspace, 'main.py')).catch(() => null))) return { ok: false, reason: 'no main.py' };
  await rm(join(workspace, 'numbers.txt'), { force: true });
  const res = await runPython(workspace, ['main.py'], { timeoutMs: 30_000, stdin: '' });
  if (res.code !== 0) return { ok: false, reason: `main.py exited with code ${res.code}: ${res.stderr.trim().split('\n').at(-1) ?? ''}` };
  const content = await readFile(join(workspace, 'numbers.txt'), 'utf8').catch(() => null);
  if (content === null) return { ok: false, reason: 'numbers.txt was not written' };
  const lines = content.trim().split(/\r?\n/).map(l => l.trim());
  if (lines.join(',') !== '1,2,3,4,5') return { ok: false, reason: `numbers.txt holds ${JSON.stringify(lines)}, expected 1..5` };
  if (!res.stdout.trim().split(/\r?\n/).some(l => l.trim() === '15')) return { ok: false, reason: `stdout ${JSON.stringify(res.stdout.trim())} does not print 15` };
  return { ok: true, reason: 'wrote numbers.txt and printed 15' };
}
