import type { RunStatus, ToolRecord } from './types.js';

export interface RunSummary { status: RunStatus; reason: string; facts: string[]; omitted: number }

/** User-facing completion facts come from tool records, not generated prose. */
export function summaryFacts(records: ToolRecord[]): string[] {
  const facts = new Set<string>();
  for (const record of records.filter(record => record.result.ok)) {
    switch (record.tool) {
      case 'write_file': facts.add(`Wrote ${String(record.args.path)}.`); break;
      case 'write_files': for (const path of Array.isArray(record.result.data?.paths) ? record.result.data.paths as string[] : []) facts.add(`Wrote ${path}.`); break;
      case 'edit_file': facts.add(`Edited ${String(record.args.path)}.`); break;
      case 'read_file': facts.add(`Read ${String(record.args.path)}.`); break;
      case 'list_files': facts.add(`Listed ${String(record.args.path)}.`); break;
      case 'set_plan': break;
      case 'bash': facts.add(`Bash exited with code ${String(record.result.data?.exitCode ?? 'unknown')}.`); break;
      default: facts.add(`Ran ${record.tool}: ${record.result.output.slice(0, 200)}`);
    }
  }
  return [...facts];
}

export function completionSummary(records: ToolRecord[]): string {
  const values = summaryFacts(records);
  if (!values.length) return 'Jev reported completion; no external tool actions were performed.';
  return values.slice(0, 12).join('\n') + (values.length > 12 ? `\n${values.length - 12} additional outcomes are in the run log.` : '');
}

/** The reason is whatever the run reported beyond the facts already carried by the records. */
export function runSummary(status: RunStatus, summary: string, records: ToolRecord[]): RunSummary {
  const facts = summaryFacts(records);
  const stated = completionSummary(records);
  const reason = summary.startsWith(stated) ? summary.slice(stated.length).trim() : summary;
  return { status, reason, facts: facts.slice(0, 12), omitted: Math.max(0, facts.length - 12) };
}
