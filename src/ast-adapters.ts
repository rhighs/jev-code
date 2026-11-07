import { readFile, mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isAbsolute, resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Decisions, State } from './decisions.js';
import type { GenerateOptions } from './generation.js';
import { generatePythonAst, generatePythonProject, validatePythonProject, validatePythonSource } from './python-ast.js';
import type { RunContext } from './run-context.js';
import { resolveWorkspacePath } from './workspace.js';
import { atomicWrite } from './tools.js';
import { bundledAstAdapters } from './lang/index.js';

export interface AstAdapter {
  id: string;
  extensions: string[];
  languages: string[];
  generate(decisions: Decisions, state: State, field: string, options: GenerateOptions): Promise<string>;
  /** Reject invalid source; validation is mandatory before a write. */
  validate(source: string, signal: AbortSignal, context?: RunContext): Promise<void>;
  /** Multi-file output as a JSON manifest of path to source, for the write_files tool. */
  generateProject?(decisions: Decisions, state: State, field: string, options: GenerateOptions): Promise<string>;
  validateProject?(files: Record<string, string>, signal: AbortSignal, context?: RunContext): Promise<void>;
}
export const pythonAstAdapter: AstAdapter = {
  id: 'python', extensions: ['.py'], languages: ['python'], generate: generatePythonAst,
  validate: (source, signal, context) => validatePythonSource(source, signal, context),
  generateProject: generatePythonProject, validateProject: (files, signal, context) => validatePythonProject(files, signal, undefined, context),
};

export class AstRegistry {
  private adapters = new Map<string, AstAdapter>();
  constructor(adapters: AstAdapter[] = [], bundled = true) { this.register(pythonAstAdapter); if (bundled) for (const adapter of bundledAstAdapters()) this.register(adapter); for (const adapter of adapters) this.register(adapter); }
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
/** Installed adapters named by a project must be re-approved until the workspace trusts them. */
export class UntrustedAstConfigError extends Error {
  constructor(readonly path: string) {
    super(`Installed AST adapters in ${path} are not trusted. Review them, then run \`jev-code ast install <module>\` or pass --trust-asts.`);
    this.name = 'UntrustedAstConfigError';
  }
}

interface Installed { id: string; module: string }
interface ConfigState { path: string; raw: string; entries: Installed[] }

const trustPath = (configPath: string): string => join(dirname(configPath), 'asts.trusted');
const digest = (raw: string): string => createHash('sha256').update(raw).digest('hex');

async function readConfigState(workspace: string): Promise<ConfigState | undefined> {
  const path = await resolveWorkspacePath(workspace, '.jev/asts.json', false);
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Invalid .jev/asts.json configuration.'); }
  const config = parsed as { version?: unknown; adapters?: unknown } | null;
  if (!config || config.version !== 1 || !Array.isArray(config.adapters) || config.adapters.length > 64 || config.adapters.some(item => !item || typeof item.id !== 'string' || typeof item.module !== 'string')) throw new Error('Invalid .jev/asts.json configuration.');
  return { path, raw, entries: config.adapters as Installed[] };
}

async function configTrusted(state: ConfigState): Promise<boolean> {
  try { return (await readFile(trustPath(state.path), 'utf8')).trim() === digest(state.raw); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function markTrusted(configPath: string, raw: string): Promise<void> {
  await writeFile(trustPath(configPath), `${digest(raw)}\n`, { mode: 0o600 });
}

/** List the adapters named by `.jev/asts.json` without importing any module. */
export async function listInstalledAstConfig(workspace: string): Promise<Array<{ id: string; module: string }>> {
  return [...(await readConfigState(workspace))?.entries ?? []];
}
export async function loadAstModule(workspace: string, specifier: string): Promise<AstAdapter[]> {
  if (specifier.startsWith('builtin:')) {
    const id = specifier.slice(8);
    const adapter = bundledAstAdapters().find(a => a.id === id);
    if (!adapter) throw new Error(`Unknown bundled AST adapter: ${id}. Bundled: ${bundledAstAdapters().map(a => a.id).join(', ')}.`);
    return [adapter];
  }
  const target = isAbsolute(specifier) || specifier.startsWith('.') ? resolve(workspace, specifier)
    : createRequire(join(resolve(workspace), 'package.json')).resolve(specifier);
  const module = await import(pathToFileURL(target).href) as { astAdapters?: AstAdapter[] };
  if (!Array.isArray(module.astAdapters) || !module.astAdapters.length) throw new Error('AST module must export a nonempty astAdapters array.');
  return module.astAdapters;
}
export interface LoadInstalledAstsOptions {
  /** Explicit approval to import the modules named by the project configuration. */
  trusted?: boolean;
}

export async function loadInstalledAsts(workspace: string, options: LoadInstalledAstsOptions = {}): Promise<AstAdapter[]> {
  const state = await readConfigState(workspace);
  if (state === undefined || state.entries.length === 0) return [];
  // Importing an adapter runs its module-level code, so a project-controlled file is not enough on
  // its own. `ast install` records trust for the exact configuration it wrote; anything else needs
  // the explicit flag.
  if (options.trusted !== true && !(await configTrusted(state))) throw new UntrustedAstConfigError(state.path);
  const modules = new Map<string, AstAdapter[]>();
  for (const entry of state.entries) if (!modules.has(entry.module)) modules.set(entry.module, await loadAstModule(workspace, entry.module));
  return state.entries.map(entry => {
    const adapter = modules.get(entry.module)!.find(adapter => adapter.id === entry.id);
    if (!adapter) throw new Error(`Installed AST adapter ${entry.id} is missing from ${entry.module}.`);
    return adapter;
  });
}

async function updateConfig(workspace: string, update: (entries: Installed[]) => Promise<Installed[]>, trust: boolean): Promise<void> {
  const path = await resolveWorkspacePath(workspace, '.jev/asts.json', false);
  await mkdir(dirname(path), { recursive: true });
  const lock = await open(join(dirname(path), 'asts.lock'), 'wx', 0o600).catch(error => { throw new Error('AST configuration is busy or inaccessible; retry after the other install finishes.', { cause: error }); });
  try {
    const current = await readConfigState(workspace);
    const raw = JSON.stringify({ version: 1, adapters: await update(current?.entries ?? []) }, null, 2) + '\n';
    await atomicWrite(path, raw, new AbortController().signal);
    if (trust) await markTrusted(path, raw);
  } finally { await lock.close(); await unlink(join(dirname(path), 'asts.lock')); }
}

export async function installAstModule(workspace: string, specifier: string): Promise<string[]> {
  if (specifier.startsWith('builtin:')) return (await loadAstModule(workspace, specifier)).map(adapter => adapter.id);
  const module = isAbsolute(specifier) || specifier.startsWith('.') ? resolve(workspace, specifier) : specifier;
  const adapters = await loadAstModule(workspace, module);
  // Installing is explicit approval of this module and the configuration it produces.
  await updateConfig(workspace, async entries => {
    const registry = new AstRegistry(await loadInstalledAsts(workspace, { trusted: true }));
    for (const adapter of adapters) registry.register(adapter);
    const result = [...entries, ...adapters.map(adapter => ({ id: adapter.id, module }))];
    if (result.length > 64) throw new Error('At most 64 AST adapters may be installed.');
    return result;
  }, true);
  return adapters.map(adapter => adapter.id);
}

export async function removeAstAdapter(workspace: string, id: string): Promise<void> {
  const current = await readConfigState(workspace);
  const wasTrusted = current === undefined ? false : await configTrusted(current);
  await updateConfig(workspace, async entries => {
    if (!entries.some(entry => entry.id === id)) throw new Error(`No installed AST adapter: ${id}`);
    return entries.filter(entry => entry.id !== id);
  }, wasTrusted);
}
