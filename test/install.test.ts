import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const execute = promisify(execFile);
const installer = resolve('install.sh');

const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const asset = `jev-code-${platform}-${arch}`;

const fakeBinary = `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = "--help" ]; then exit "\${JEV_TEST_HELP_EXIT:-0}"; fi
printf '['
first=1
for arg in "$@"; do
  if [ "$first" = 0 ]; then printf ','; fi
  first=0
  esc="\${arg//\\\\/\\\\\\\\}"
  esc="\${esc//\\"/\\\\\\"}"
  printf '"%s"' "$esc"
done
printf ']\\n'
`;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'jev-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releases = join(root, 'releases');
  const tools = join(root, 'tools');
  await mkdir(releases, { recursive: true });
  await mkdir(tools);
  await writeFile(join(releases, asset), fakeBinary, { mode: 0o755 });
  const checksum = createHash('sha256').update(await readFile(join(releases, asset))).digest('hex');
  await writeFile(join(releases, 'SHA256SUMS'), `${checksum}  ${asset}\n`);
  await writeFile(join(tools, 'curl'), `#!/usr/bin/env bash
set -eu
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
[ -n "$url" ] || { echo 'no url' >&2; exit 1; }
cp "$JEV_TEST_RELEASES/\${url##*/}" "$out"
`, { mode: 0o755 });
  const installRoot = join(root, 'app with spaces');
  const binRoot = join(root, 'bin with spaces');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
    JEV_TEST_RELEASES: releases,
    JEV_VERSION: '0.3.0',
    JEV_RELEASE_BASE: 'https://example.test/releases',
    JEV_INSTALL_DIR: installRoot,
    JEV_BIN_DIR: binRoot,
  };
  delete env.TYPESAFE_API_KEY;
  return { root, releases, installRoot, binRoot, env };
}

test('installer handles spaced paths, executable arguments and repeat installs', async t => {
  const f = await fixture(t);
  const first = await execute('bash', [installer], { env: f.env, cwd: f.root });
  assert.match(first.stdout, /Installed Jev Code/);
  const launcher = join(f.binRoot, 'jev-code');
  assert.deepEqual(JSON.parse((await execute(launcher, ['--workspace', 'a space', 'literal $word'], { env: f.env, cwd: f.root })).stdout), ['--workspace', 'a space', 'literal $word']);
  const before = await readlink(join(f.installRoot, 'current'));
  assert.match(before, /releases\/0\.3\.0-darwin|releases\/0\.3\.0-linux/);
  await execute('bash', [installer], { env: f.env, cwd: f.root });
  assert.notEqual(await readlink(join(f.installRoot, 'current')), before);
  await execute('bash', [installer], { env: f.env, cwd: f.root });
  assert.equal((await readdir(join(f.installRoot, 'releases'))).length, 2, 'retain current and previous releases');
  assert.ok(!(await readdir(f.installRoot)).some(path => path.startsWith('.install.')));
  assert.deepEqual(JSON.parse((await execute(launcher, ['--help-check'], { env: f.env, cwd: f.root })).stdout), ['--help-check']);
});

test('a checksum mismatch preserves the working release and launcher', async t => {
  const f = await fixture(t);
  await execute('bash', [installer], { env: f.env, cwd: f.root });
  const before = await readlink(join(f.installRoot, 'current'));
  const launcher = join(f.binRoot, 'jev-code');
  const content = await readFile(launcher, 'utf8');
  await writeFile(join(f.releases, 'SHA256SUMS'), `${'0'.repeat(64)}  ${asset}\n`);
  await assert.rejects(execute('bash', [installer], { env: f.env, cwd: f.root }), error => /checksum mismatch/.test(String(error)));
  assert.equal(await readlink(join(f.installRoot, 'current')), before);
  assert.equal(await readFile(launcher, 'utf8'), content);
  assert.deepEqual(JSON.parse((await execute(launcher, ['still', 'works'], { env: f.env, cwd: f.root })).stdout), ['still', 'works']);
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

test('installer rejects a binary that cannot run before publishing an installation', async t => {
  const f = await fixture(t);
  await assert.rejects(execute('bash', [installer], { env: { ...f.env, JEV_TEST_HELP_EXIT: '7' }, cwd: f.root }),
    error => /did not run/.test(String(error)));
  await assert.rejects(readlink(join(f.installRoot, 'current')), { code: 'ENOENT' });
});

test('installer rejects a release without a checksum entry', async t => {
  const f = await fixture(t);
  await writeFile(join(f.releases, 'SHA256SUMS'), `${'a'.repeat(64)}  some-other-asset\n`);
  await assert.rejects(execute('bash', [installer], { env: f.env, cwd: f.root }),
    error => /No checksum/.test(String(error)));
  await assert.rejects(readlink(join(f.installRoot, 'current')), { code: 'ENOENT' });
});
