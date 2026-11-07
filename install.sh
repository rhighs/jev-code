#!/usr/bin/env bash
set -euo pipefail
unset TYPESAFE_API_KEY

# Installs a prebuilt Bun standalone binary from GitHub Releases into user-owned directories.
# No sudo, runtime, package manager, or API key is required.
fail() { printf 'Jev Code: %s\n' "$*" >&2; exit 1; }
for tool in curl mktemp; do command -v "$tool" >/dev/null || fail "Missing required tool: $tool"; done
if command -v sha256sum >/dev/null; then sha='sha256sum';
elif command -v shasum >/dev/null; then sha='shasum -a 256';
else fail 'SHA-256 verification needs sha256sum or shasum.'; fi

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

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) fail 'Prebuilt binaries support macOS and Linux only. Build from source with Bun on other systems.' ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail 'Prebuilt binaries support arm64 and x64 only.' ;;
esac
asset="jev-code-$platform-$arch"

tag="${JEV_VERSION:-}"
if [ -z "$tag" ]; then
  latest_url="$(curl --proto '=https' --tlsv1.2 -fsSL -o /dev/null -w '%{url_effective}' --retry 2 --connect-timeout 10 --max-time 60 'https://github.com/rhighs/jev-code/releases/latest')" \
    || fail 'Could not resolve the latest Jev Code release.'
  tag="${latest_url##*/}"
fi
[[ "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+ ]] || fail "Invalid Jev Code release version: $tag"
tag="v${tag#v}"
base="${JEV_RELEASE_BASE:-https://github.com/rhighs/jev-code/releases/download/$tag}"

staging="$(mktemp -d "$install_root/.install.XXXXXX")"
launcher_tmp=''
release=''
published=''
cleanup() {
  rm -rf "$staging"
  if [ -n "$release" ] && [ -z "$published" ]; then rm -rf "$release"; fi
  if [ -n "$launcher_tmp" ]; then rm -f "$launcher_tmp"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() { curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --connect-timeout 10 --max-time 180 "$1" -o "$2"; }

# `mv src existing-symlink-to-dir` follows the destination on both GNU and BSD mv. `-T` (GNU) and
# `-h` (BSD) make it replace the symlink itself, and rename(2) keeps the swap atomic.
if mv --version >/dev/null 2>&1; then
  replace_symlink() { mv -fT "$1" "$2"; }
else
  replace_symlink() { mv -fh "$1" "$2"; }
fi

printf 'Downloading Jev Code %s for %s-%s…\n' "$tag" "$platform" "$arch"
fetch "$base/SHA256SUMS" "$staging/SHA256SUMS"
fetch "$base/$asset" "$staging/$asset"
checksum="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$staging/SHA256SUMS")"
[[ "$checksum" =~ ^[a-f0-9]{64}$ ]] || fail "No checksum for $asset in $tag."
actual="$($sha "$staging/$asset")"
[ "${actual%% *}" = "$checksum" ] || fail 'Jev Code binary checksum mismatch.'
chmod 755 "$staging/$asset"
"$staging/$asset" --help >/dev/null || fail 'The downloaded Jev Code binary did not run.'
rm -f "$staging/SHA256SUMS"

printf 'Installing Jev Code…\n'
release="$(mktemp -d "$install_root/releases/${tag#v}-$platform-$arch.XXXXXX")"
mv "$staging/$asset" "$release/jev-code"
printf 'Jev Code release\n' > "$release/.jev-release"
ln -s "$release" "$staging/current"
previous_release=''
if [ -L "$install_root/current" ]; then previous_release="$(readlink "$install_root/current")"; fi
replace_symlink "$staging/current" "$install_root/current"
published=1

launcher_tmp="$(mktemp "$bin_root/.jev-code.XXXXXX")"
{
  printf '#!/usr/bin/env bash\n# Jev Code launcher\nset -e\n'
  printf 'exec %q "$@"\n' "$install_root/current/jev-code"
} > "$launcher_tmp"
chmod 755 "$launcher_tmp"
mv -f "$launcher_tmp" "$launcher"
launcher_tmp=''

for old_release in "$install_root"/releases/*; do
  if [ "$old_release" != "$release" ] && [ "$old_release" != "$previous_release" ] && [ -f "$old_release/.jev-release" ]; then rm -rf "$old_release"; fi
done
printf '\nInstalled Jev Code: %s\nRun: %s\n' "$launcher" "$launcher"
case ":$PATH:" in *":$bin_root:"*) ;; *) printf 'For this shell: export PATH=%q:"$PATH"\n' "$bin_root" ;; esac
if ! command -v python3 >/dev/null || ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
  printf 'Python AST generation needs Python 3.9+ (python3 on PATH). Bash and installed adapters work without it.\n'
fi
printf 'Set TYPESAFE_API_KEY in your environment or project .env before your first task.\n'
