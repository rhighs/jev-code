import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Decisions } from '../src/decisions.js';
import { Harness } from '../src/harness.js';
import { generatePythonProject, validatePythonProject } from '../src/python-ast.js';
import { completionSummary } from '../src/summary.js';
import { builtInTools, toolContext } from '../src/tools.js';
import { resolveWorkspacePath } from '../src/workspace.js';
import { SlotProvider, type SlotEntry } from './helpers.js';

const run = promisify(execFile);
const signal = new AbortController().signal;
const options = { maxSteps: 300, maxBytes: 8000, allowEmpty: false, fragments: [] };

async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jev-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const context = (root: string) => toolContext(root, signal, path => resolveWorkspacePath(root, path));
const writeFiles = () => builtInTools().find(tool => tool.name === 'write_files')!;
const listAll = async (dir: string): Promise<string[]> => (await readdir(dir, { recursive: true })).filter(entry => !entry.endsWith('__pycache__')).sort();

const prompt = 'Create a Python package greeter with a module helper holding greet(name) and shout(name), and a main script that prints greet.';
const state = { task: { prompt, turn: 1, updates: [] } };
const layout: SlotEntry[] = [
  { slot: 'unit_count', answer: '2' }, { slot: 'package_name', answer: { value: 'greeter' } }, { slot: 'module_count', answer: '1' }, { slot: 'module_0_name', answer: { value: 'helper' } },
  { slot: 'unit_0_name', answer: { value: 'greet' } }, { slot: 'unit_0_arity', answer: '1' }, { slot: 'unit_0_purpose', answer: { value: 'greet' } }, { slot: 'unit_0_parameter_0', answer: { value: 'name' } },
  { slot: 'unit_1_name', answer: { value: 'shout' } }, { slot: 'unit_1_arity', answer: '1' }, { slot: 'unit_1_purpose', answer: { value: 'shout' } }, { slot: 'unit_1_parameter_0', answer: { value: 'name' } },
];
const mainBlock: SlotEntry[] = [
  { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' }, once: true }, { slot: 'argument_count', answer: '1' },
  { slot: 'argument_0', answer: 'call', once: true }, { slot: 'callee', answer: { value: 'greet' } }, { slot: 'argument_0', answer: 'string' }, { slot: 'string', answer: { value: 'greet' } },
  { slot: 'module_body', answer: 'finish' },
];
const returnString = (unit: string): SlotEntry[] => [
  { unit, slot: 'function_body', answer: 'return' }, { unit, slot: 'expression', answer: 'string' }, { unit, slot: 'string', answer: { value: unit } },
];

test('helper module and main assemble with the derived import at module level inside a guarded main.py', async t => {
  const root = await workspace(t);
  const provider = new SlotProvider([...layout, { slot: 'unit_0_module', answer: 'module_0' }, { slot: 'unit_1_module', answer: 'module_0' }, ...returnString('greet'), ...returnString('shout'), ...mainBlock]);
  const manifest = JSON.parse(await generatePythonProject(new Decisions(provider, 300, signal), state, 'files', options)) as Record<string, string>;
  assert.deepEqual(Object.keys(manifest).sort(), ['greeter/__init__.py', 'greeter/helper.py', 'main.py']);
  assert.equal(manifest['greeter/__init__.py'], '');
  assert.match(manifest['greeter/helper.py']!, /^def greet\(name\):\n    return 'greet'\n\ndef shout\(name\):\n    return 'shout'\n$/);
  assert.equal(manifest['main.py'], "from greeter.helper import greet\nif __name__ == '__main__':\n    print(greet('greet'))\n");
  assert.ok(provider.states.every(s => s.generation?.unit === undefined || !JSON.stringify(s).includes('def shout(name):\n    return') || s.generation.unit === 'shout'));
  await writeFiles().execute({ files: JSON.stringify(manifest) }, context(root));
  const { stdout } = await run('python3', ['main.py'], { cwd: root });
  assert.equal(stdout, 'greet\n');
});

test('two package units calling each other across modules get body-level imports and validate', async t => {
  const root = await workspace(t);
  const provider = new SlotProvider([
    { slot: 'unit_count', answer: '2' }, { slot: 'package_name', answer: { value: 'greeter' } }, { slot: 'module_count', answer: '2' }, { slot: 'module_0_name', answer: { value: 'helper' } }, { slot: 'module_1_name', answer: { value: 'main' } },
    { slot: 'unit_0_name', answer: { value: 'greet' } }, { slot: 'unit_0_arity', answer: '1' }, { slot: 'unit_0_purpose', answer: { value: 'greet' } }, { slot: 'unit_0_parameter_0', answer: { value: 'name' } }, { slot: 'unit_0_module', answer: 'module_0' },
    { slot: 'unit_1_name', answer: { value: 'shout' } }, { slot: 'unit_1_arity', answer: '1' }, { slot: 'unit_1_purpose', answer: { value: 'shout' } }, { slot: 'unit_1_parameter_0', answer: { value: 'name' } }, { slot: 'unit_1_module', answer: 'module_1' },
    { unit: 'greet', slot: 'function_body', answer: 'if', once: true }, { unit: 'greet', slot: 'condition', answer: 'compare' }, { unit: 'greet', slot: 'operator', answer: 'Eq' },
    { unit: 'greet', slot: 'left', answer: 'name' }, { unit: 'greet', slot: 'reference', answer: 'name_0' }, { unit: 'greet', slot: 'right', answer: 'string' }, { unit: 'greet', slot: 'string', answer: { value: 'shout' } },
    { unit: 'greet', slot: 'if_body', answer: 'return' }, { unit: 'greet', slot: 'expression', answer: 'call', once: true }, { unit: 'greet', slot: 'callee', answer: { value: 'shout' } }, { unit: 'greet', slot: 'argument_0', answer: 'name' },
    { unit: 'greet', slot: 'else_branch', answer: 'no' }, { unit: 'greet', slot: 'function_body', answer: 'return' }, { unit: 'greet', slot: 'expression', answer: 'name' },
    { unit: 'shout', slot: 'function_body', answer: 'return' }, { unit: 'shout', slot: 'expression', answer: 'call' }, { unit: 'shout', slot: 'callee', answer: { value: 'greet' } }, { unit: 'shout', slot: 'argument_0', answer: 'string' }, { unit: 'shout', slot: 'string', answer: { value: 'greet' } },
    { slot: 'module_body', answer: 'expr', once: true }, { slot: 'expression', answer: 'call' }, { slot: 'callee', answer: { value: 'print' }, once: true }, { slot: 'argument_count', answer: '1' },
    { slot: 'argument_0', answer: 'call', once: true }, { slot: 'callee', answer: { value: 'greet' } }, { slot: 'argument_0', answer: 'string' }, { slot: 'string', answer: { value: 'shout' } }, { slot: 'module_body', answer: 'finish' },
  ]);
  const manifest = JSON.parse(await generatePythonProject(new Decisions(provider, 300, signal), state, 'files', options)) as Record<string, string>;
  assert.match(manifest['greeter/helper.py']!, /def greet\(name\):\n    from greeter\.main import shout\n    if name == 'shout':\n        return shout\(name\)\n    return name\n/);
  assert.match(manifest['greeter/main.py']!, /def shout\(name\):\n    from greeter\.helper import greet\n    return greet\('greet'\)\n/);
  assert.doesNotMatch(manifest['greeter/helper.py']!, /^from/m);
  await validatePythonProject(manifest, signal);
  await writeFiles().execute({ files: JSON.stringify(manifest) }, context(root));
  assert.equal((await run('python3', ['main.py'], { cwd: root })).stdout, 'greet\n');
});

test('unit module candidates exclude entry units as peers of package units', async t => {
  const provider = new SlotProvider([...layout, { slot: 'unit_0_module', answer: 'main' }, { slot: 'unit_1_module', answer: 'module_0' }, ...returnString('greet'), ...returnString('shout'), ...mainBlock]);
  const manifest = JSON.parse(await generatePythonProject(new Decisions(provider, 300, signal), state, 'files', options)) as Record<string, string>;
  assert.match(manifest['main.py']!, /^def greet\(name\):\n    return 'greet'\nif __name__ == '__main__':\n    print\(greet\('greet'\)\)\n$/);
  const shout = provider.states.find(s => s.generation?.unit === 'shout' && s.generation.slot === 'function_body') as { generation: { peers?: Array<{ name: string }> } };
  assert.deepEqual(shout.generation.peers?.map(p => p.name), ['shout']);
  const greet = provider.states.find(s => s.generation?.unit === 'greet' && s.generation.slot === 'function_body') as { generation: { peers?: Array<{ name: string }> } };
  assert.deepEqual(greet.generation.peers?.map(p => p.name), ['greet', 'shout']);
  await t.test('running the guarded entry executes the main block', async () => {
    const root = await workspace(t);
    await writeFiles().execute({ files: JSON.stringify(manifest) }, context(root));
    assert.equal((await run('python3', ['main.py'], { cwd: root })).stdout, 'greet\n');
    assert.equal((await run('python3', ['-c', 'import main'], { cwd: root })).stdout, '');
  });
});

test('validation is static: unresolved imports and syntax errors write nothing, top-level code never runs', async t => {
  const root = await workspace(t);
  const dir = await mkdtemp(join(tmpdir(), 'jev-validate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = writeFiles();
  await assert.rejects(tool.execute({ files: JSON.stringify({ 'main.py': 'from greeter.missing import greet\n', 'greeter/__init__.py': '' }) }, context(root)), /greeter\.missing/);
  await assert.rejects(tool.execute({ files: JSON.stringify({ 'main.py': 'from greeter.helper import nothing\n', 'greeter/__init__.py': '', 'greeter/helper.py': 'def greet(name):\n    return name\n' }) }, context(root)), /nothing/);
  await assert.rejects(tool.execute({ files: JSON.stringify({ 'main.py': 'print(\n', 'ok.py': 'x = 1\n' }) }, context(root)), /main\.py/);
  await assert.rejects(tool.execute({ files: JSON.stringify({ 'main.py': 'from random.core import x\n', 'random/__init__.py': '', 'random/core.py': 'x = 1\n' }) }, context(root)), /random shadows an installed module/);
  assert.deepEqual(await listAll(root), []);
  await validatePythonProject({ 'main.py': "open('side-effect.txt', 'w').write('ran')\nimport os\nfrom os import path\n" }, signal, dir);
  assert.deepEqual(await listAll(dir), ['main.py']);
  await validatePythonProject({ 'main.py': 'import json\nfrom greeter import helper\nfrom greeter.helper import greet\n', 'greeter/__init__.py': '', 'greeter/helper.py': 'def greet(name):\n    return name\n' }, signal);
});

test('write_files rejects unsafe paths before validation and writes valid sets all at once', async t => {
  const root = await workspace(t);
  const outside = await mkdtemp(join(tmpdir(), 'jev-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'escape'));
  const tool = writeFiles();
  await assert.rejects(tool.execute({ files: JSON.stringify({ '../evil.py': 'print(', 'main.py': 'print(' }) }, context(root)), /manifest path/i);
  await assert.rejects(tool.execute({ files: JSON.stringify({ 'escape/new.py': 'print(', 'main.py': 'print(' }) }, context(root)), /escapes workspace/);
  await assert.rejects(tool.execute({ files: JSON.stringify({ 'a-b/x.py': '' }) }, context(root)), /manifest path/i);
  await assert.rejects(tool.execute({ files: '[1, 2]' }, context(root)), /manifest/i);
  assert.deepEqual(await listAll(outside), []);
  assert.deepEqual(await listAll(root), ['escape']);
  const manifest = { 'main.py': "from pkg.mod import f\nif __name__ == '__main__':\n    print(f())\n", 'pkg/__init__.py': '', 'pkg/mod.py': 'def f():\n    return 1\n' };
  const first = await tool.execute({ files: JSON.stringify(manifest) }, context(root));
  assert.equal(first.ok, true);
  assert.deepEqual((first.data?.paths as string[]).sort(), ['main.py', 'pkg/__init__.py', 'pkg/mod.py']);
  assert.match(first.output, /main\.py/);
  assert.equal(await readFile(join(root, 'pkg/mod.py'), 'utf8'), 'def f():\n    return 1\n');
  await chmod(join(root, 'main.py'), 0o755);
  const again = await tool.execute({ files: JSON.stringify({ ...manifest, 'pkg/mod.py': 'def f():\n    return 2\n' }) }, context(root));
  assert.equal(again.ok, true);
  assert.equal((await stat(join(root, 'main.py'))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(root, 'pkg/mod.py'), 'utf8'), 'def f():\n    return 2\n');
  assert.deepEqual(await listAll(join(root, 'pkg')), ['__init__.py', 'mod.py']);
  assert.equal(completionSummary([{ turn: 1, tool: 'write_files', args: { files: JSON.stringify(manifest) }, result: again }]), 'Wrote main.py.\nWrote pkg/__init__.py.\nWrote pkg/mod.py.');
});

test('harness end to end: write_files is selected, the manifest is generated, files exist, and the run completes', async t => {
  const root = await workspace(t);
  const provider = new SlotProvider([
    { slot: 'selection', answer: 'write_files', once: true }, { slot: 'selection', answer: 'finish', once: true }, { slot: 'selection', answer: 'complete' },
    ...layout, { slot: 'unit_0_module', answer: 'module_0' }, { slot: 'unit_1_module', answer: 'module_0' }, ...returnString('greet'), ...returnString('shout'), ...mainBlock,
  ]);
  const result = await new Harness({ workspace: root, provider, journalDirectory: false }).run(prompt);
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(result.records[0]?.tool, 'write_files');
  assert.equal(result.records[0]?.result.ok, true);
  assert.deepEqual(await listAll(root), ['greeter', 'greeter/__init__.py', 'greeter/helper.py', 'main.py']);
  assert.match(result.summary, /Wrote main\.py\./);
  assert.equal((await run('python3', ['main.py'], { cwd: root })).stdout, 'greet\n');
});

test('write_files leaves existing files untouched when a target is not a regular file or two entries alias one file', async t => {
  const root = await workspace(t);
  const tool = writeFiles();
  const manifest = { 'main.py': "from pkg.mod import f\nprint(f())\n", 'pkg/__init__.py': '', 'pkg/mod.py': 'def f():\n    return 1\n' };
  await writeFile(join(root, 'main.py'), 'original\n');
  await mkdir(join(root, 'pkg', 'mod.py'), { recursive: true });
  await assert.rejects(tool.execute({ files: JSON.stringify(manifest) }, context(root)), /not a regular file/);
  assert.equal(await readFile(join(root, 'main.py'), 'utf8'), 'original\n');
  assert.deepEqual(await listAll(root), ['main.py', 'pkg', 'pkg/mod.py']);
  await rm(join(root, 'pkg', 'mod.py'), { recursive: true });
  await writeFile(join(root, 'pkg', 'mod.py'), 'def f():\n    return 0\n');
  await symlink('mod.py', join(root, 'pkg', 'alias.py'));
  await assert.rejects(tool.execute({ files: JSON.stringify({ ...manifest, 'pkg/alias.py': 'def f():\n    return 2\n' }) }, context(root)), /pkg\/mod\.py and pkg\/alias\.py resolve to the same file/);
  assert.equal(await readFile(join(root, 'main.py'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(root, 'pkg', 'mod.py'), 'utf8'), 'def f():\n    return 0\n');
  assert.deepEqual(await listAll(root), ['main.py', 'pkg', 'pkg/alias.py', 'pkg/mod.py']);
});
