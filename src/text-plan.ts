import type { Decisions, State } from './decisions.js';
import { completionSummary } from './summary.js';
import type { ToolRecord } from './types.js';

/** A shared intent keeps independent positions from inventing different programs. */
export async function planText(decisions: Decisions, state: State, field: string, files: string[] = []): Promise<string | undefined> {
  const task = state.task as { prompt?: string; updates?: string[] } | undefined;
  if (!task?.prompt) return undefined;
  const prompt = [task.prompt, ...(task.updates ?? [])].join('\n');
  const args = state.argumentsSoFar as Record<string, unknown> | undefined;
  const taskFiles: string[] = prompt.match(/[\w./-]+\.(?:py|[cm]?[jt]sx?|sh|json|md|txt|html|css|rs|go|java|rb|c|cpp)\b/g) ?? [];
  const language = /\bpython\b/i.test(prompt) || String(args?.path ?? '').endsWith('.py') ? 'python' :
    /\b(?:typescript|javascript)\b/i.test(prompt) || /\.[cm]?[jt]sx?$/.test(String(args?.path ?? '')) ? 'javascript' : undefined;
  const select = async (candidates: string[], instruction: string): Promise<string | undefined> => {
    const unique = [...new Set(candidates.filter(value => !value.includes('\0')))].slice(0, 200);
    const criteria: Record<string, string> = { free: 'No offered whole-field plan satisfies the task. Compose text from bounded token choices.' };
    unique.forEach((value, index) => { criteria[`plan_${index}`] = JSON.stringify(value); });
    if (!unique.length) return undefined;
    const selected = await decisions.choose({ ...state, generation: { field, phase: 'plan' } }, `${instruction}\nTask: ${prompt}\nChoose a shared exact text plan only if it satisfies this field.`, criteria);
    return selected === 'free' ? undefined : unique[Number(selected.slice(5))];
  };
  if (field === 'cwd') return select(['.'], 'Choose the Bash working directory; . means the selected workspace.');
  if (field === 'path') {
    const candidates = [...taskFiles];
    if (state.action !== 'write_file' && state.action !== 'propose') {
      if (state.action === 'list_files') candidates.push('.');
      candidates.push(...files);
      return select(candidates, 'Choose an existing path named by the task or listed in the workspace.');
    }
    if (!candidates.length && language) {
      const extension = language === 'python' ? 'py' : /typescript/i.test(prompt) ? 'ts' : 'js';
      candidates.push(`main.${extension}`, `script.${extension}`);
    }
    if (!candidates.length) candidates.push('main.py', 'main.ts', 'main.js', 'main.sh');
    return select(candidates, 'Choose a destination path explicitly requested by the user, or a conventional filename for a new standalone program.');
  }
  if (field === 'content') {
    const code = [...prompt.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(match => match[1]!);
    const literals = [...prompt.matchAll(/`([^`\n]+)`|"([^"\n]+)"/g)].map(match => match[1] ?? match[2]!).filter(value => !taskFiles.includes(value));
    const literal = await select(code.concat(literals), 'Select exact file contents only if the task explicitly supplies those contents. Do not mistake a signature, example output or incidental quoted text for a complete program.');
    if (literal !== undefined) return literal;
    if (!language) return undefined;
    const form = await decisions.choose({ ...state, generation: { field, phase: 'plan_form' } }, `For this file, does the task require only a standalone program that prints a literal message, or more complex code? Task: ${prompt}`,
      { print: 'Only a simple standalone literal-message print program is required.', free: 'Other source, logic, functions or behavior is required; compose the required source.' });
    if (form !== 'print') return undefined;
    const ignored = new Set('a an the create make write simple program script file python python3 javascript typescript hello-world run it with to verify test and world'.split(' '));
    // Phrase variants come from the task, not a fixed hello-world source template.
    const words = prompt.match(/[\p{L}\p{N}]+/gu) ?? [];
    const phrases: string[] = [];
    for (let start = 0; start < words.length; start++) {
      if (ignored.has(words[start]!.toLowerCase())) continue;
      for (let count = 1; count <= 4 && start + count <= words.length; count++) {
        const phraseWords = words.slice(start, start + count);
        const phrase = phraseWords.join(' ');
        const capital = phrase[0]!.toUpperCase() + phrase.slice(1);
        phrases.push(phrase, capital, capital + '!');
        if (count > 1) phrases.push(phraseWords[0]![0]!.toUpperCase() + phraseWords[0]!.slice(1) + ', ' + phraseWords.slice(1).join(' ') + '!');
      }
    }
    const message = await select(literals.concat(phrases), 'Select the literal message the program must print. Prefer an explicitly specified message; otherwise use a conventional rendering of the requested phrase.');
    if (message === undefined) return undefined;
    return `${language === 'python' ? 'print' : 'console.log'}(${JSON.stringify(message)})${language === 'python' ? '' : ';'}\n`;
  }
  if (field === 'command') {
    const recent = Array.isArray(state.recent) ? state.recent : [];
    const files = [...taskFiles, ...recent.filter(record => record.result?.ok && record.tool === 'write_file').map(record => record.args?.path).filter((path): path is string => typeof path === 'string')];
    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
    const commands = [...prompt.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!);
    for (const file of new Set(files)) {
      if (file.endsWith('.py')) commands.push(`python3 ${quote(file)}`);
      if (/\.[cm]?js$/.test(file)) commands.push(`node ${quote(file)}`);
      if (file.endsWith('.ts')) commands.push(`node --experimental-strip-types ${quote(file)}`);
      if (file.endsWith('.sh')) commands.push(`bash ${quote(file)}`);
    }
    return select(commands, 'Select the exact requested command or an actual verification command for a file just created. Do not select a filename or code snippet as a shell command.');
  }
  if (field === 'summary' && Array.isArray(state.recent) && state.recent.length) {
    return select([completionSummary(state.recent as ToolRecord[])], 'Choose a factual summary based on observed tool results.');
  }
  return undefined;
}
