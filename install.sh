#!/usr/bin/env bash
set -euo pipefail
unset TYPESAFE_API_KEY

# Installs from main into user-owned directories. No sudo or API key required.
fail() { printf 'Jev Code: %s\n' "$*" >&2; exit 1; }
for tool in curl tar mktemp; do command -v "$tool" >/dev/null || fail "Missing required tool: $tool"; done
install_root="${JEV_INSTALL_DIR:-${XDG_DATA_HOME:-${HOME:?}/.local/share}/jev-code}"
bin_root="${JEV_BIN_DIR:-${HOME:?}/.local/bin}"
mkdir -p "$install_root/releases" "$bin_root"
install_root="$(cd "$install_root" && pwd -P)"
bin_root="$(cd "$bin_root" && pwd -P)"
launcher="$bin_root/jev-code"
check_launcher() {
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    if ! [ -f "$launcher" ] || ! grep -q '^# Jev Code launcher$' "$launcher"; then fail "$launcher already exists and is not a Jev Code launcher. Choose JEV_BIN_DIR."; fi
  fi
}
check_launcher
staging="$(mktemp -d "$install_root/.install.XXXXXX")"
launcher_tmp=''
cleanup() { rm -rf "$staging"; if [ -n "$launcher_tmp" ]; then rm -f "$launcher_tmp"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() { curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --connect-timeout 10 --max-time 180 "$1" -o "$2"; }

node_bin=''
if command -v node >/dev/null && command -v npm >/dev/null; then
  major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
  if [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 22 ]; then node_bin="$(command -v node)"; fi
fi
if [ -z "$node_bin" ]; then
  case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'Automatic Node installation supports macOS and Linux only. Install Node.js 22+ and npm first.' ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'Automatic Node installation supports arm64 and x64 only.' ;; esac
  printf 'Installing a private Node.js 24 runtime…\n'
  node_url='https://nodejs.org/dist/latest-v24.x'
  fetch "$node_url/SHASUMS256.txt" "$staging/checksums"
  checksum=''; archive=''
  while read -r digest filename; do
    if [[ "$filename" =~ ^node-v24\.[0-9]+\.[0-9]+-$platform-$arch\.tar\.gz$ ]]; then checksum="$digest"; archive="$filename"; break; fi
  done < "$staging/checksums"
  [[ "$checksum" =~ ^[a-f0-9]{64}$ ]] || fail 'No matching official Node.js archive found.'
  runtime="$install_root/runtime/${archive%.tar.gz}"
  if [ -x "$runtime/bin/node" ] && [ -x "$runtime/bin/npm" ] && "$runtime/bin/node" -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' >/dev/null 2>&1; then
    printf 'Reusing the installed private Node.js runtime.\n'
  else
  [ ! -e "$runtime" ] || fail "Cached Node runtime is broken: $runtime. Remove it and rerun the installer."
  fetch "$node_url/$archive" "$staging/node.tar.gz"
  if command -v sha256sum >/dev/null; then actual="$(sha256sum "$staging/node.tar.gz")";
  elif command -v shasum >/dev/null; then actual="$(shasum -a 256 "$staging/node.tar.gz")";
  else fail 'SHA-256 verification needs sha256sum or shasum.'; fi
  [ "${actual%% *}" = "$checksum" ] || fail 'Node.js archive checksum mismatch.'
  mkdir "$staging/runtime"
  tar -xzf "$staging/node.tar.gz" -C "$staging/runtime" --strip-components=1
  mkdir -p "$(dirname "$runtime")"
  mv "$staging/runtime" "$runtime"
  fi
  node_bin="$runtime/bin/node"
  export PATH="$runtime/bin:$PATH"
fi
node_bin="$("$node_bin" -p 'process.execPath')"

printf 'Downloading Jev Code…\n'
fetch 'https://codeload.github.com/rhighs/jev-code/tar.gz/refs/heads/main' "$staging/source.tar.gz"
mkdir "$staging/source"
tar -xzf "$staging/source.tar.gz" -C "$staging/source" --strip-components=1
printf 'Building Jev Code…\n'
(
  cd "$staging/source"
  npm ci --ignore-scripts --no-audit --no-fund
  npm run build
  npm prune --omit=dev --ignore-scripts --no-audit --no-fund
)
"$node_bin" "$staging/source/dist/cli.js" --help >/dev/null

check_launcher
launcher_tmp="$(mktemp "$bin_root/.jev-code.XXXXXX")"
{
  printf '#!/usr/bin/env bash\n# Jev Code launcher\nset -e\n'
  printf 'exec %q %q "$@"\n' "$node_bin" "$install_root/current/dist/cli.js"
} > "$launcher_tmp"
chmod 755 "$launcher_tmp"
release="$install_root/releases/$(basename "$staging")"
printf 'Jev Code release\n' > "$staging/source/.jev-release"
mv "$staging/source" "$release"
ln -s "$release" "$staging/current"
previous_release=''
if [ -L "$install_root/current" ]; then previous_release="$(readlink "$install_root/current")"; fi
# rename() replaces an existing symlink atomically on macOS and Linux.
atomic_rename() { "$node_bin" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$1" "$2"; }
atomic_rename "$staging/current" "$install_root/current"
atomic_rename "$launcher_tmp" "$launcher"
launcher_tmp=''
for old_release in "$install_root"/releases/.install.*; do
  if [ "$old_release" != "$release" ] && [ "$old_release" != "$previous_release" ] && [ -f "$old_release/.jev-release" ]; then rm -rf "$old_release"; fi
done
printf '\nInstalled Jev Code: %s\nRun: %s\n' "$launcher" "$launcher"
case ":$PATH:" in *":$bin_root:"*) ;; *) printf 'For this shell: export PATH=%q:"$PATH"\n' "$bin_root" ;; esac
if ! command -v python3 >/dev/null || ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
  printf 'Python AST generation needs Python 3.9+ (python3 on PATH). Bash and installed adapters work without it.\n'
fi
printf 'Set TYPESAFE_API_KEY in your environment or project .env before your first task.\n'
