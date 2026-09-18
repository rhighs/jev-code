import type { Decisions, State } from './decisions.js';
import type { GenerateOptions } from './generation.js';
import { compactContext, MAX_GRID_REQUEST_BYTES } from './scored-grid.js';
import { gridCursor } from './grid.js';
import { LimitError } from './types.js';
import { choice } from '@typesafe-ai/sdk';

/** Whole spans and bounded token productions replace open character grids. */
export async function generateStructuredText(decisions: Decisions, state: State, field: string, description: string, options: GenerateOptions): Promise<string> {
  const context = compactContext(state);
  const raw = [JSON.stringify(state.task ?? {}), ...options.fragments].join('\n').slice(0, 24_000);
  const quoted = [...raw.matchAll(/`([^`]+)`|"([^"\n]+)"|'([^'\n]+)'/g)].map(match => match[1] ?? match[2] ?? match[3]!);
  const spans = raw.match(/[\p{L}\p{N}_./-]+(?:\s+[\p{L}\p{N}_./-]+){0,3}/gu) ?? [];
  const atoms = raw.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
  const domain = field === 'path' || field === 'cwd' ? ['main.py', 'main.ts', 'main.js', 'main.txt', 'README.md', './', 'src/', 'test/', '.py', '.ts', '.js', '.mjs', '.txt', '.json', '.md', '/', '.', '_', '-']
    : field === 'command' ? ['python3 ', 'node ', 'npm test', 'npm run build', 'npm run typecheck', 'pytest', 'python3 -m py_compile ', 'printf ', 'cat ', 'test ', ' && ', ' | ', "'", '"', '$(cat ', ')', ' = ', 'wc -c < ', './'] : [];
  const values = [...new Set([...domain, ...quoted, ...spans, ...atoms].filter(value => value && !value.includes('\0')))].slice(0, 145);
  // Scalar tokens permit values absent from the objective without allocating an output grid.
  for (let code = 32; code <= 126; code++) if (!values.includes(String.fromCharCode(code))) values.push(String.fromCharCode(code));
  for (const whitespace of ['\n', '\t', '\r']) if (!values.includes(whitespace)) values.push(whitespace);
  const tokens = values.map((value, index) => ({ key: `token_${index}`, value }));
  const maxTokens = Math.min(options.maxSteps, field === 'path' || field === 'cwd' ? 32 : field === 'command' ? 96 : 128);
  let text = '';
  for (let step = 1; step <= maxTokens; step++) {
    const criteria: Record<string, string> = Object.fromEntries(tokens.map(token => [token.key, JSON.stringify(token.value)]));
    if (text || options.allowEmpty) criteria.END = 'The complete field satisfies the task. Finish it now.';
    const input = { ...context, generation: { field, phase: 'tokens', draft: text, remainingTokens: maxTokens - step } };
    const instruction = `Construct the exact ${field}: ${description}. Choose the longest useful next span. Prefer existing paths, task literals and conventional filenames. Do not repeat text. END only when the complete value satisfies the objective. Current value: ${JSON.stringify(text)}.`;
    if (Buffer.byteLength(JSON.stringify({ state: input, questions: { selection: choice(instruction, criteria) } })) > MAX_GRID_REQUEST_BYTES) throw new LimitError(`Structured ${field} context exceeds the safe request budget.`);
    const selected = await decisions.choose(input, instruction, criteria);
    if (selected === 'END') {
      await options.onText?.(field, text, true, { replace: text }, { decoder: 'choice', step, cursor: gridCursor(text), bytes: Buffer.byteLength(text) });
      return text;
    }
    text += tokens.find(token => token.key === selected)!.value;
    if (Buffer.byteLength(text) > options.maxBytes) throw new LimitError(`${field} exceeds its byte limit.`);
    if ((field === 'path' || field === 'cwd') && /[\x00-\x1f\x7f]/.test(text)) throw new LimitError('Generated path contains control characters.');
    await options.onText?.(field, text, false, { replace: text }, { decoder: 'choice', step, cursor: gridCursor(text), bytes: Buffer.byteLength(text) });
  }
  throw new LimitError(`Structured ${field} exhausted ${maxTokens} token productions; incomplete text was not executed.`);
}
