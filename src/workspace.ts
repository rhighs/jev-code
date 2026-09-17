import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Resolve existing symlinks, including ancestors of files that do not exist yet. */
export async function resolveWorkspacePath(workspace: string, input: string, allowOutside = false): Promise<string> {
  if (!input || input.includes('\0')) throw new Error('A nonempty path without NUL bytes is required.');
  const root = await realpath(workspace);
  const target = resolve(root, input);
  let ancestor = target;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  // A dangling symlink fails realpath instead of being mistaken for a new file.
  const canonical = resolve(await realpath(ancestor), relative(ancestor, target));
  if (!allowOutside && !isWithin(root, canonical)) throw new Error(`Path escapes workspace: ${input}`);
  return canonical;
}

const OMIT = new Set(['.git', '.jev', 'node_modules', '.venv', '__pycache__', 'dist', 'build']);

export async function listWorkspace(workspace: string, maxFiles = 300): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  async function walk(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      if (OMIT.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      // Inventory never follows symlinks. Direct file tools resolve them explicitly.
      if (entry.isDirectory()) await walk(path);
      else files.push(relative(workspace, path) + (entry.isSymbolicLink() ? ' [symlink]' : ''));
    }
  }
  await walk(workspace);
  return { files, truncated };
}
