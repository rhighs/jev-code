import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const execute = promisify(execFile);
const installer = resolve('install.sh');
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'jev-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'archive/jev-code-main');
  const tools = join(root, 'tools');
  await mkdir(source, { recursive: true });
  await mkdir(tools);
  await writeFile(join(source, 'package.json'), '{}');
  const archive = join(root, 'source.tar.gz');
  await execute('tar', ['-czf', archive, '-C', join(root, 'archive'), 'jev-code-main']);
  await writeFile(join(tools, 'curl'), '#!/usr/bin/env bash\nset -eu\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then cp "$JEV_TEST_ARCHIVE" "$2"; exit; fi; shift; done\nexit 1\n', { mode: 0o755 });
  await writeFile(join(tools, 'corepack'), '#!/usr/bin/env bash\nset -eu\nif [ "${JEV_TEST_BUILD_FAIL:-}" = "1" ]; then exit 42; fi\nif [ "$1" = "pnpm" ] && [ "$2" = "run" ]; then mkdir -p dist; printf "console.log(JSON.stringify(process.argv.slice(2)));\\n" > dist/cli.js; fi\n', { mode: 0o755 });
  const installRoot = join(root, 'app with spaces');
  const binRoot = join(root, 'bin with spaces');
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${tools}:${process.env.PATH}`, JEV_TEST_ARCHIVE: archive, JEV_INSTALL_DIR: installRoot, JEV_BIN_DIR: binRoot };
  delete env.TYPESAFE_API_KEY;
  return { root, installRoot, binRoot, tools, env };
}

test('installer handles spaced paths, executable arguments and repeat installs', async t => {
  const f = await fixture(t);
  const first = await execute('bash', [installer], { env: f.env, cwd: f.root });
  assert.match(first.stdout, /Installed Jev Code/);
  const launcher = join(f.binRoot, 'jev-code');
  assert.deepEqual(JSON.parse((await execute(launcher, ['--workspace', 'a space', 'literal $word'], { env: f.env, cwd: f.root })).stdout), ['--workspace', 'a space', 'literal $word']);
  const before = await readlink(join(f.installRoot, 'current'));
  await execute('bash', [installer], { env: f.env, cwd: f.root });
  assert.notEqual(await readlink(join(f.installRoot, 'current')), before);
  await execute('bash', [installer], { env: f.env, cwd: f.root });
  assert.equal((await readdir(join(f.installRoot, 'releases'))).length, 2, 'retain current and previous releases');
  assert.ok(!(await readdir(f.installRoot)).some(path => path.startsWith('.install.')));
});

test('failed installer updates preserve the working release and launcher', async t => {
  const f = await fixture(t);
  await execute('bash', [installer], { env: f.env, cwd: f.root });
  const before = await readlink(join(f.installRoot, 'current'));
  const launcher = join(f.binRoot, 'jev-code');
  const content = await readFile(launcher, 'utf8');
  await assert.rejects(execute('bash', [installer], { env: { ...f.env, JEV_TEST_BUILD_FAIL: '1' }, cwd: f.root }));
  assert.equal(await readlink(join(f.installRoot, 'current')), before);
  assert.equal(await readFile(launcher, 'utf8'), content);
  assert.deepEqual(JSON.parse((await execute(launcher, ['--help'], { env: f.env, cwd: f.root })).stdout), ['--help']);
  assert.ok(!(await readdir(f.installRoot)).some(path => path.startsWith('.install.')));
});

test('installer refuses to overwrite an unrelated program with the same name', async t => {
  const f = await fixture(t);
  await mkdir(f.binRoot);
  const launcher = join(f.binRoot, 'jev-code');
  await writeFile(launcher, 'keep me');
  await assert.rejects(execute('bash', [installer], { env: f.env, cwd: f.root }), error => /not a Jev Code launcher/.test(String(error)));
  assert.equal(await readFile(launcher, 'utf8'), 'keep me');
});

test('private Node bootstrap rejects corrupted downloads before publishing an installation', async t => {
  const f = await fixture(t);
  await writeFile(join(f.tools, 'node'), '#!/usr/bin/env bash\necho 20\n', { mode: 0o755 });
  await writeFile(join(f.tools, 'curl'), '#!/usr/bin/env bash\nset -eu\nmanifest=0\nfor arg in "$@"; do case "$arg" in *SHASUMS256.txt) manifest=1;; esac; done\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then if [ "$manifest" = 1 ]; then printf "%064d  node-v24.1.0-$(uname -s | tr \'[:upper:]\' \'[:lower:]\')-$(case $(uname -m) in arm64|aarch64) echo arm64;; *) echo x64;; esac).tar.gz\\n" 0 > "$2"; else printf corrupted > "$2"; fi; exit; fi; shift; done\n', { mode: 0o755 });
  await assert.rejects(execute('bash', [installer], { env: f.env, cwd: f.root }), error => /checksum mismatch/.test(String(error)));
  await assert.rejects(readlink(join(f.installRoot, 'current')), { code: 'ENOENT' });
});

test('private Node bootstrap verifies, extracts and launches a working runtime', async t => {
  const f = await fixture(t);
  const runtime = join(f.root, 'node-fixture/bin');
  await mkdir(runtime, { recursive: true });
  await symlink(process.execPath, join(runtime, 'node'));
  await writeFile(join(runtime, 'corepack'), await readFile(join(f.tools, 'corepack')), { mode: 0o755 });
  const archive = join(f.root, 'node.tar.gz');
  await execute('tar', ['-czf', archive, '-C', f.root, 'node-fixture']);
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  const name = `node-v24.1.0-${process.platform}-${process.arch}.tar.gz`;
  const manifest = join(f.root, 'manifest');
  await writeFile(manifest, `${hash}  ${name}\n`);
  await writeFile(join(f.tools, 'node'), '#!/usr/bin/env bash\necho 20\n', { mode: 0o755 });
  await writeFile(join(f.tools, 'curl'), '#!/usr/bin/env bash\nset -eu\ninput="$JEV_TEST_ARCHIVE"\nfor arg in "$@"; do case "$arg" in *SHASUMS256.txt) input="$JEV_TEST_MANIFEST";; *node-v24*.tar.gz) input="$JEV_TEST_NODE_ARCHIVE";; esac; done\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then cp "$input" "$2"; exit; fi; shift; done\n', { mode: 0o755 });
  const env = { ...f.env, JEV_TEST_NODE_ARCHIVE: archive, JEV_TEST_MANIFEST: manifest };
  await execute('bash', [installer], { env, cwd: f.root });
  assert.deepEqual(JSON.parse((await execute(join(f.binRoot, 'jev-code'), ['--help'], { env, cwd: f.root })).stdout), ['--help']);
  assert.ok((await readdir(join(f.installRoot, 'runtime'))).includes(name.replace(/\.tar\.gz$/, '')));
  await execute('bash', [installer], { env: { ...env, JEV_TEST_NODE_ARCHIVE: '/missing-archive' }, cwd: f.root });
});
