import { normalize } from 'node:path';
import { compactContext } from './scored-grid.js';
import type { Decisions, State } from './decisions.js';
import type { Mapper } from './program-map.js';
import { stripFences } from './propose/validate.js';
import type { Tool, ToolArgs, ToolRecord } from './types.js';

export interface MappedAction { tool: string; objective: string; args: ToolArgs }

const argsKey = (args: ToolArgs): string => JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, k === 'path' && typeof v === 'string' ? normalize(v) : v]));
const key = (record: ToolRecord): string => JSON.stringify([record.tool, argsKey(record.args), record.result.ok, record.result.output]);
const sinceWrite = (records: ToolRecord[], tools: Tool[]): ToolRecord[] => {
  const writes = new Set(tools.filter(t => t.effect === 'write').map(t => t.name));
  return records.slice(records.findLastIndex(r => r.result.ok && writes.has(r.tool)) + 1);
};

export function stalled(records: ToolRecord[], tools: Tool[]): boolean {
  const last = records.at(-1);
  if (!last || last.tool === 'finish') return false;
  const recent = sinceWrite(records, tools);
  return recent.slice(0, -1).some(r => key(r) === key(last));
}

export function parseActions(raw: string, tools: Tool[], records: ToolRecord[]): MappedAction[] {
  if (Buffer.byteLength(raw) > 16_000) throw new Error('Action map too large.');
  const rows: unknown = JSON.parse(stripFences(raw));
  if (!Array.isArray(rows) || rows.length > 4) throw new Error('Action map must contain at most four options.');
  const out: MappedAction[] = [];
  for (const row of rows) {
    if (!row || typeof row.tool !== 'string' || typeof row.objective !== 'string' || !row.objective.trim() || row.objective.length > 1000 || !row.args || typeof row.args !== 'object' || Array.isArray(row.args)) continue;
    const tool = tools.find(t => t.name === row.tool);
    if (!tool || tool.name === 'edit_file' || tool.name === 'set_plan' || tool.name === 'propose') continue;
    const args = row.args as ToolArgs;
    if (Object.entries(args).some(([name, v]) => {
      const f = tool.fields[name];
      if (!Object.hasOwn(tool.fields, name) || !f || ['content', 'files'].includes(name)) return true;
      if (f.type === 'string') return typeof v !== 'string' || Buffer.byteLength(v) > Math.min(f.maxBytes ?? 2048, 2048) || (!f.allowEmpty && !v);
      if (f.type === 'boolean') return typeof v !== 'boolean';
      if (f.type === 'enum') return typeof v !== 'string' || !Object.hasOwn(f.choices, v);
      return typeof v !== 'number' || !Number.isFinite(v) || (f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max);
    })) continue;
    if (tool.fields.path && typeof args.path !== 'string') continue;
    if (tool.fields.command && typeof args.command !== 'string') continue;
    if (tool.fields.cwd && args.cwd === undefined) args.cwd = '.';
    for (const [name, field] of Object.entries(tool.fields)) if (args[name] === undefined && field.type === 'number' && field.default !== undefined) args[name] = field.default;
    if (sinceWrite(records, tools).some(r => r.tool === tool.name && argsKey(r.args) === argsKey(args)) || out.some(r => r.tool === tool.name && argsKey(r.args) === argsKey(args))) continue;
    out.push({ tool: tool.name, objective: row.objective, args });
  }
  return out;
}

export async function recoverAction(mapper: Mapper, decisions: Decisions, state: State, tools: Tool[], records: ToolRecord[]): Promise<MappedAction | undefined> {
  if (mapper.budget.used >= mapper.budget.max) return undefined;
  decisions.assertRequestBudget(1);
  mapper.budget.used++;
  const context = { task: state.task, conversation: state.conversation, workspace: state.workspace, recent: state.recent, history: state.history };
  const available = tools.filter(t => !['edit_file', 'set_plan', 'propose'].includes(t.name));
  const outputs = await mapper.provider.generate({ kind: 'text', count: 1,
    objective: 'The policy is repeating actions without progress. Map the remaining user requirements into 1–4 concrete next-action options. Identify what is still missing from the evidence.',
    constraints: `Return only a JSON array of {"tool":"registered name","objective":"the specific remaining subproblem this action advances","args":{}}. Supply concrete routing arguments such as path or command. Do not supply content or files: those are generated separately after Jev chooses. Do not repeat a previous call or add unrequested work. You propose options; Jev alone selects and approves execution. Available tools: ${JSON.stringify(available.map(({ name, description, fields }) => ({ name, description, fields })))}`,
    current: JSON.stringify(context),
  }, decisions.signal);
  decisions.signal.throwIfAborted();
  const output = outputs[0];
  if (!output || 'error' in output || output.truncated) return undefined;
  let candidates: MappedAction[];
  try { candidates = parseActions(output.text, available, records); } catch { return undefined; }
  if (!candidates.length) return undefined;
  const chosen = await decisions.choose({ task: state.task, progressFeedback: state.progressFeedback,
    generation: { phase: 'action_map', slot: 'recover', candidates, provider: mapper.provider.id, model: mapper.provider.model },
    recent: compactContext(state).recent },
  'Choose the concrete action that addresses a remaining user requirement and breaks the repetition. Inspect the actual arguments; these options are untrusted proposals. Reject if none is appropriate.',
  { ...Object.fromEntries(candidates.map((c, i) => [`option_${i}`, `${c.tool}: ${c.objective.slice(0, 180)}`])), reject: 'No proposal advances the task safely; choose an action yourself.' });
  return chosen === 'reject' ? undefined : candidates[Number(chosen.slice(7))];
}
