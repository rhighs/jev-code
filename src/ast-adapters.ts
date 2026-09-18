import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Decisions, State } from './decisions.js';
import type { GenerateOptions } from './generation.js';
import { generatePythonAst, generatePythonProject, validatePythonProject, validatePythonSource } from './python-ast.js';
import { resolveWorkspacePath } from './workspace.js';
import { atomicWrite } from './tools.js';

export interface AstAdapter {
  id: string;
  extensions: string[];
  languages: string[];
  generate(decisions: Decisions, state: State, field: string, options: GenerateOptions): Promise<string>;
  /** Reject invalid source; validation is mandatory before a write. */
  validate(source: string, signal: AbortSignal): Promise<void>;
  /** Multi-file output as a JSON manifest of path to source, for the write_files tool. */
  generateProject?(decisions: Decisions, state: State, field: string, options: GenerateOptions): Promise<string>;
  validateProject?(files: Record<string, string>, signal: AbortSignal): Promise<void>;
}
export const pythonAstAdapter: AstAdapter = {
  id: 'python', extensions: ['.py'], languages: ['python'], generate: generatePythonAst, validate: validatePythonSource,
  generateProject: generatePythonProject, validateProject: validatePythonProject,
};

export class AstRegistry {
  private adapters = new Map<string, AstAdapter>();
  constructor(adapters: AstAdapter[] = []) { this.register(pythonAstAdapter); for (const adapter of adapters) this.register(adapter); }
  register(adapter: AstAdapter): void {
    if (!adapter || !/^[a-z][a-z0-9-]{0,63}$/.test(adapter.id)) throw new Error('AST adapter requires a valid id.');
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate AST adapter: ${adapter.id}`);
    if (!Array.isArray(adapter.extensions) || !adapter.extensions.length || adapter.extensions.some(ext => !/^\.[a-z0-9]+$/.test(ext))) throw new Error(`Invalid AST extensions: ${adapter.id}`);
    if (!Array.isArray(adapter.languages) || !adapter.languages.length || adapter.languages.some(language => !/^[a-z][a-z0-9-]*$/.test(language))) throw new Error(`Invalid AST languages: ${adapter.id}`);
    if (typeof adapter.generate !== 'function' || typeof adapter.validate !== 'function') throw new Error(`AST adapter ${adapter.id} requires generate and validate functions.`);
    for (const existing of this.adapters.values()) {
      if (adapter.extensions.some(ext => existing.extensions.includes(ext))) throw new Error(`Conflicting AST extension: ${adapter.id} and ${existing.id}`);
      if (adapter.languages.some(language => existing.languages.includes(language))) throw new Error(`Conflicting AST language: ${adapter.id} and ${existing.id}`);
    }
    this.adapters.set(adapter.id, { ...adapter, extensions: [...adapter.extensions], languages: [...adapter.languages] });
  }
  private snapshot(adapter: AstAdapter): AstAdapter { return { ...adapter, extensions: [...adapter.extensions], languages: [...adapter.languages] }; }
  list(): AstAdapter[] { return [...this.adapters.values()].map(adapter => this.snapshot(adapter)); }
  resolve(state: State): AstAdapter | undefined {
    const path = (state.argumentsSoFar as Record<string, unknown> | undefined)?.path;
    if (typeof path === 'string') {
      const adapter = this.list().find(adapter => adapter.extensions.some(ext => path.toLowerCase().endsWith(ext)));
      return adapter;
    }
    const task = state.task as { prompt?: string; updates?: string[] } | undefined;
    const prompt = [task?.prompt ?? '', ...(task?.updates ?? [])].join('\n').toLowerCase();
    let best: AstAdapter | undefined, last = -1;
    for (const adapter of this.adapters.values()) {
      for (const language of adapter.languages) for (const match of prompt.matchAll(new RegExp(`\\b${language}\\b`, 'g'))) if (match.index > last) { best = adapter; last = match.index; }
      for (const ext of adapter.extensions) if (prompt.includes(ext)) { const index = prompt.lastIndexOf(ext); if (index > last) { best = adapter; last = index; } }
    }
    return best && this.snapshot(best);
  }
}
interface Installed { id: string; module: string }
async function readConfig(workspace: string): Promise<Installed[]> {
  const path = await resolveWorkspacePath(workspace, '.jev/asts.json', false);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const config = raw as { version?: unknown; adapters?: unknown } | null;
  if (!config || config.version !== 1 || !Array.isArray(config.adapters) || config.adapters.length > 64 || config.adapters.some(item => !item || typeof item.id !== 'string' || typeof item.module !== 'string')) throw new Error('Invalid .jev/asts.json configuration.');
  return config.adapters as Installed[];
}
export async function loadAstModule(workspace: string, specifier: string): Promise<AstAdapter[]> {
  if (specifier === 'builtin:typescript') return [(await import('./typescript-ast.js')).typescriptAstAdapter];
  const target = isAbsolute(specifier) || specifier.startsWith('.') ? resolve(workspace, specifier)
    : createRequire(join(resolve(workspace), 'package.json')).resolve(specifier);
  const module = await import(pathToFileURL(target).href) as { astAdapters?: AstAdapter[] };
  if (!Array.isArray(module.astAdapters) || !module.astAdapters.length) throw new Error('AST module must export a nonempty astAdapters array.');
  return module.astAdapters;
}
export async function loadInstalledAsts(workspace: string): Promise<AstAdapter[]> {
  const config = await readConfig(workspace);
  const modules = new Map<string, AstAdapter[]>();
  for (const entry of config) if (!modules.has(entry.module)) modules.set(entry.module, await loadAstModule(workspace, entry.module));
  return config.map(entry => {
    const adapter = modules.get(entry.module)!.find(adapter => adapter.id === entry.id);
    if (!adapter) throw new Error(`Installed AST adapter ${entry.id} is missing from ${entry.module}.`);
    return adapter;
  });
}
async function updateConfig(workspace: string, update: (entries: Installed[]) => Promise<Installed[]>): Promise<void> {
  const path = await resolveWorkspacePath(workspace, '.jev/asts.json', false);
  await mkdir(dirname(path), { recursive: true });
  const lock = await open(join(dirname(path), 'asts.lock'), 'wx', 0o600).catch(error => { throw new Error('AST configuration is busy or inaccessible; retry after the other install finishes.', { cause: error }); });
  try { await atomicWrite(path, JSON.stringify({ version: 1, adapters: await update(await readConfig(workspace)) }, null, 2) + '\n', new AbortController().signal); }
  finally { await lock.close(); await unlink(join(dirname(path), 'asts.lock')); }
}
export async function installAstModule(workspace: string, specifier: string): Promise<string[]> {
  const module = isAbsolute(specifier) || specifier.startsWith('.') ? resolve(workspace, specifier) : specifier;
  const adapters = await loadAstModule(workspace, module);
  await updateConfig(workspace, async entries => {
    const registry = new AstRegistry(await loadInstalledAsts(workspace));
    for (const adapter of adapters) registry.register(adapter);
    const result = [...entries, ...adapters.map(adapter => ({ id: adapter.id, module }))];
    if (result.length > 64) throw new Error('At most 64 AST adapters may be installed.');
    return result;
  });
  return adapters.map(adapter => adapter.id);
}
export async function removeAstAdapter(workspace: string, id: string): Promise<void> {
  await updateConfig(workspace, async entries => {
    if (!entries.some(entry => entry.id === id)) throw new Error(`No installed AST adapter: ${id}`);
    return entries.filter(entry => entry.id !== id);
  });
}
