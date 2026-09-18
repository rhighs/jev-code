import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runPython, type CheckResult } from '../../src/eval.js';

const cfg = JSON.parse(await readFile(new URL('./task.json', import.meta.url), 'utf8')) as { range: { min: number; max: number }; limits?: { maxRunMs?: number } };

export default async function check(workspace: string): Promise<CheckResult> {
  if (!(await stat(join(workspace, 'main.py')).catch(() => null))) return { ok: false, reason: 'no main.py' };
  let lo = cfg.range.min, hi = cfg.range.max, guesses = 0, correct = false, bad: string | undefined;
  const maxGuesses = Math.ceil(Math.log2(hi - lo + 1)) + 3;
  let guess = 0;
  const next = (write: (text: string) => void): void => {
    if (lo > hi || guesses >= maxGuesses) { bad ??= `no correct answer after ${guesses} guesses`; return; }
    guess = Math.floor((lo + hi) / 2);
    guesses++;
    write(`${guess}\n`);
  };
  const res = await runPython(workspace, ['main.py'], {
    timeoutMs: 30_000,
    onStart: next,
    onLine: (line, write) => {
      if (correct || bad) return;
      const text = line.toLowerCase();
      if (/correct|got it/.test(text)) { correct = true; return; }
      if (/too high|lower/.test(text)) hi = guess - 1;
      else if (/too low|higher/.test(text)) lo = guess + 1;
      else if (text.trim()) { bad = `unrecognized line: ${line.trim()}`; return; }
      else return;
      next(write);
    },
  });
  if (correct && res.code === 0) return { ok: true, reason: `correct after ${guesses} guesses` };
  if (bad) return { ok: false, reason: bad };
  if (res.timedOut) return { ok: false, reason: 'timed out waiting for feedback' };
  return { ok: false, reason: `program exited with code ${res.code} before the correct guess${res.stderr.trim() ? `: ${res.stderr.trim().split('\n').at(-1)}` : ''}` };
}
