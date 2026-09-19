import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = join(root, 'test/fixtures/package-consumer');
const npmEnvironment = {
  ...process.env,
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
};

// npm is intentional here: this is an npm consumer interoperability test, not a repository workflow.

const run = async (file: string, args: readonly string[], cwd: string) => exec(file, [...args], {
  cwd,
  env: npmEnvironment,
  maxBuffer: 10 * 1024 * 1024,
});

const failureText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & { stdout?: string; stderr?: string };
  return `${details.message}\n${details.stdout ?? ''}\n${details.stderr ?? ''}`;
};

test('packed ESM package satisfies the public consumer contract', { timeout: 180_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'jev-code-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const packed = join(temporary, 'packed');
  const consumer = join(temporary, 'consumer');
  await mkdir(packed);
  await mkdir(consumer);

  await mkdir(join(root, 'dist/providers'), { recursive: true });
  await writeFile(join(root, 'dist/providers/stale.js'), 'export const stale = true;\n');
  await writeFile(join(root, 'dist/propose.js'), 'export const stale = true;\n');
  await run('npm', ['pack', '--silent', '--pack-destination', packed], root);
  const archives = (await readdir(packed)).filter(file => file.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'npm pack should produce one archive');
  const archive = join(packed, archives[0]!);

  const { stdout: tarOutput } = await run('tar', ['-tzf', archive], root);
  const entries = tarOutput.trim().split('\n').filter(Boolean);
  const exactFiles = new Set([
    'package/package.json',
    'package/README.md',
    'package/docs/sdk.md',
    'package/examples/router.ts',
    'package/examples/dependency-tree.ts',
  ]);
  const unexpected = entries.filter(entry => !entry.startsWith('package/dist/') && !exactFiles.has(entry));
  assert.deepEqual(unexpected, [], `unexpected tarball entries:\n${unexpected.join('\n')}`);
  for (const expected of exactFiles) assert.ok(entries.includes(expected), `missing ${expected}`);
  assert.ok(entries.includes('package/dist/index.js'));
  assert.ok(entries.includes('package/dist/index.d.ts'));
  assert.ok(entries.includes('package/dist/cli.js'));
  const removedPaths = [
    'providers/', 'propose/', 'propose.js', 'action-map.js', 'action-map.d.ts', 'program-map.js', 'program-map.d.ts',
  ];
  for (const removed of removedPaths) {
    assert.ok(!entries.some(entry => entry.startsWith(`package/dist/${removed}`)), `removed path shipped: ${removed}`);
  }

  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2));
  for (const file of [
    'runtime.mjs',
    'nodenext.mts',
    'bundler.mts',
    'deep-import.mjs',
    'deep-import.mts',
    'tsconfig.nodenext.json',
    'tsconfig.bundler.json',
  ]) {
    await copyFile(join(fixtures, file), join(consumer, file));
  }
  await run('npm', ['install', '--ignore-scripts', '--package-lock=false', archive], consumer);

  for (const dependency of ['ink', 'ink-text-input', 'react']) {
    await rm(join(consumer, 'node_modules', dependency), { recursive: true, force: true });
  }
  await run(process.execPath, ['runtime.mjs'], consumer);

  const tsc = join(root, 'node_modules/.bin/tsc');
  await run(tsc, ['-p', 'tsconfig.nodenext.json'], consumer);
  await run(tsc, ['-p', 'tsconfig.bundler.json'], consumer);

  const declarations = await import('node:fs/promises').then(fs => fs.readFile(join(consumer, 'node_modules/jev-code/dist/index.d.ts'), 'utf8'));
  const sdkDeclarations = await import('node:fs/promises').then(fs => fs.readFile(join(consumer, 'node_modules/jev-code/dist/sdk/index.d.ts'), 'utf8'));
  for (const removed of ['proposeTool', 'ProposalProvider', 'ProviderSpec', 'mapProgram', 'mapAction']) {
    assert.doesNotMatch(declarations, new RegExp(`\\b${removed}\\b`), `removed symbol remains public: ${removed}`);
  }
  assert.doesNotMatch(declarations, /\bRunResources\b/, 'mutable RunResources remains public');
  assert.doesNotMatch(declarations, /\bwithResources\b/, 'session resource rebinding remains public');
  assert.match(sdkDeclarations, /ProgramResourceView/, 'read-only program resource view is missing');

  await assert.rejects(
    run(process.execPath, ['deep-import.mjs'], consumer),
    error => /ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath/.test(failureText(error)),
  );
  await assert.rejects(
    run(tsc, [
      '--noEmit',
      '--strict',
      '--target', 'ES2023',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      'deep-import.mts',
    ], consumer),
    error => /TS2307|Cannot find module/.test(failureText(error)),
  );

  const cli = join(consumer, 'node_modules/.bin/jev-code');
  const { stdout: help } = await run(cli, ['--help'], consumer);
  assert.match(help, /jev-code \[options\]/);

  const tsx = join(root, 'node_modules/.bin/tsx');
  const router = await run(tsx, ['examples/router.ts'], root);
  assert.equal(router.stdout.trim(), 'account: priority 1');
  const tree = await run(tsx, ['examples/dependency-tree.ts'], root);
  assert.equal(tree.stdout.trim(), '{"name":"Oak","children":[{"name":"Birch","children":[{"name":"Elm","children":[]},{"name":"Ash","children":[]}]},{"name":"Cedar","children":[{"name":"Pine","children":[]},{"name":"Oak","children":[]}]}]}');
});
