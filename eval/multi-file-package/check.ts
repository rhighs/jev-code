import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runPython, type CheckResult } from '../../src/eval.js';

async function pyFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '__pycache__' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await pyFiles(p));
    else if (e.name.endsWith('.py')) out.push(p);
  }
  return out;
}

export default async function check(workspace: string): Promise<CheckResult> {
  const files = await pyFiles(workspace);
  if (files.length < 2) return { ok: false, reason: `expected two or more .py files, found ${files.length}` };
  if (!(await stat(join(workspace, 'main.py')).catch(() => null))) return { ok: false, reason: 'no main.py' };
  const res = await runPython(workspace, ['main.py'], { timeoutMs: 30_000, stdin: '' });
  if (res.code !== 0) return { ok: false, reason: `main.py exited with code ${res.code}: ${res.stderr.trim().split('\n').at(-1) ?? ''}` };
  if (!res.stdout.includes('Hello, World!')) return { ok: false, reason: `stdout ${JSON.stringify(res.stdout.trim())} lacks Hello, World!` };
  return { ok: true, reason: `${files.length} python files; main.py printed the greeting` };
}
