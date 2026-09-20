export const PENDING = '__jev_pending__';

export interface ContextPart {
  key: string;
  value: unknown;
  required?: boolean;
  shrink?: (value: unknown, level: number) => unknown;
}

const radii = [40, 20, 10, 4, 2];

export function windowSource(value: unknown, level: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const radius = radii[level - 1];
  if (radius === undefined) return undefined;
  const lines = value.replace(/\n$/, '').split('\n');
  const at = Math.max(0, lines.findIndex(line => line.includes(PENDING)));
  let head = 0;
  while (head < lines.length && head < 6 && /^(?:import|from)\b/.test(lines[head]!)) head++;
  const start = Math.max(head, at - radius), end = Math.min(lines.length, at + radius + 1);
  const out = [...lines.slice(0, head)];
  if (start > head) out.push(`# ... ${start - head} lines omitted`);
  out.push(...lines.slice(start, end));
  if (end < lines.length) out.push(`# ... ${lines.length - end} lines omitted`);
  return out.join('\n') + '\n';
}

export function buildDecisionContext(parts: ContextPart[], measure: (values: Record<string, unknown>) => number, cap: number): { values: Record<string, unknown>; trimmed: string[] } {
  const values: Record<string, unknown> = Object.fromEntries(parts.map(part => [part.key, part.value]));
  const trimmed: string[] = [];
  if (measure(values) <= cap) return { values, trimmed };
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (part.required) continue;
    if (part.shrink) {
      let shrunk = false;
      for (let level = 1; ; level++) {
        const next = part.shrink(part.value, level);
        if (next === undefined) break;
        if (next === values[part.key]) continue;
        values[part.key] = next;
        shrunk = true;
        if (measure(values) <= cap) break;
      }
      if (shrunk) trimmed.push(part.key);
    } else {
      delete values[part.key];
      trimmed.push(part.key);
    }
    if (measure(values) <= cap) return { values, trimmed };
  }
  return { values, trimmed };
}

export interface AstStateInput { objective: string; context: Record<string, unknown>; preview: string; core: Record<string, unknown>; questions: unknown; cap: number }

export function astDecisionState({ objective, context, preview, core, questions, cap }: AstStateInput): Record<string, unknown> {
  const assemble = (values: Record<string, unknown>): Record<string, unknown> => ({
    task: values.task, ...(values.recent === undefined ? {} : { recent: values.recent }), ...(values.plan === undefined ? {} : { plan: values.plan }),
    generation: { ...core, partialSource: values.source, ...(values.trimmed === undefined ? {} : { trimmed: values.trimmed }) },
  });
  const { values, trimmed } = buildDecisionContext([
    { key: 'task', value: { prompt: objective }, required: true },
    { key: 'core', value: core, required: true },
    { key: 'source', value: preview, shrink: windowSource },
    { key: 'recent', value: context.recent ?? [] },
    ...(typeof context.plan === 'string' && context.plan ? [{ key: 'plan', value: context.plan }] : []),
  ], parts => Buffer.byteLength(JSON.stringify({ state: assemble(parts), questions })), cap);
  return assemble(trimmed.length ? { ...values, trimmed } : values);
}
