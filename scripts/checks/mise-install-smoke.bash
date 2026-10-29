#!/usr/bin/env bash
set -euo pipefail

# Exercises the `mise use --raw --global 'npm:@slop-lab/dim-installer@<version>'` install
# path end to end inside a disposable container: a local npm registry is
# seeded with the freshly built package tarballs (never the real npm
# registry), mise resolves/installs the installer facade through it, and the
# resulting `dim` runs the same dispatch checks the design doc requires. The
# image's Node.js is then removed from PATH to prove the facade bootstraps
# Node.js 24 through `mise exec` without adding Node.js to global mise config,
# including facade-only help/version, the mise-detected --no-local-bin default,
# an explicit --local-bin override, and proxying to the installed DIM CLI.
#
# Requires Docker. Network access is required to install mise and to let the
# local registry proxy ordinary public dependencies (e.g. commander) that
# aren't part of this workspace.
#
# Current mise/aube releases prompt before installing a requested package below
# the weekly-download threshold. --raw is required for that prompt and its
# input to reach the terminal; this non-interactive smoke supplies the same Y
# approval through stdin.

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
mise_version="${DIM_PINNED_MISE_VERSION:-v2026.8.4}"
image="${DIM_MISE_SMOKE_IMAGE:-node:22-bookworm}"

source_dir="$(mktemp -d /tmp/dim-mise-smoke-src.XXXXXX)"
container_id=""
cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$source_dir"
}
trap cleanup EXIT

cd "$repo_root"
echo "[mise-smoke] build workspace packages"
pnpm run workspace:build >/dev/null

echo "[mise-smoke] pack tarballs"
node scripts/pack-local-packages.ts "$repo_root" "$source_dir" >/dev/null
core_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*dim-host-core*.tgz' -print -quit)"
cli_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*dim-cli*.tgz' -print -quit)"
install_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*dim-installer*.tgz' -print -quit)"
contracts_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*dim-contracts-external-url*.tgz' -print -quit)"
cloudflare_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*host-plugin-dns-cloudflare*.tgz' -print -quit)"
host_mirrors_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*host-plugin-mirrors*.tgz' -print -quit)"
test -n "$core_tarball" && test -n "$cli_tarball" && test -n "$install_tarball"
test -n "$contracts_tarball"
test -n "$cloudflare_tarball" && test -n "$host_mirrors_tarball"

cp "$repo_root/scripts/checks/lib/local-npm-registry.bash" "$source_dir/local-npm-registry.bash"

# Everything below runs entirely inside the container's own filesystem (the
# host directory is mounted read-only and copied once) so a root-owned
# verdaccio storage tree never ends up on the host bind mount for a
# non-root host user to clean up.
cat > "$source_dir/run.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /work
mkdir -p /node_modules
mv /.pnpm /node_modules/.pnpm
ln -s "/node_modules/.pnpm/$VERDACCIO_PACKAGE_DIR/node_modules/verdaccio" /node_modules/verdaccio
cp /mnt/*.tgz /mnt/local-npm-registry.bash /work/
cd /work
source /work/local-npm-registry.bash
trap dim_stop_local_npm_registry EXIT

echo "[container] start local npm registry"
dim_start_local_npm_registry /work

echo "[container] publish local tarballs to the local registry"
dim_publish_to_local_registry /work/*.tgz

echo "[container] install mise ($PINNED_MISE_VERSION)"
curl -fsSL https://mise.run | MISE_VERSION="$PINNED_MISE_VERSION" sh >/tmp/mise-install.log 2>&1 \
  || { cat /tmp/mise-install.log; exit 1; }
export PATH="$HOME/.local/bin:$PATH"
mise --version

echo "[container] mise use --raw --global npm:@slop-lab/dim-installer@$DIM_PACKAGE_VERSION"
printf 'Y\n' | mise use --raw --global "npm:@slop-lab/dim-installer@$DIM_PACKAGE_VERSION"

echo "[container] remove the image Node.js from PATH; keep only mise and system utilities"
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/bin:/bin"
hash -r
if node --version >/dev/null 2>&1; then
  echo "expected no active Node.js before the DIM facade bootstrap" >&2
  exit 1
fi
if mise ls --global | grep -Eq '^node[[:space:]]'; then
  echo "expected Node.js to be absent from global mise configuration" >&2
  exit 1
fi

dim_path="$(command -v dim)"
echo "resolved dim: $dim_path"
case "$dim_path" in
  */mise/*) ;;
  *) echo "expected dim to resolve inside mise's install tree, got: $dim_path" >&2; exit 1 ;;
esac

echo "[container] dim --help / --version before the DIM CLI is installed"
help1="$(dim --help)"
grep -q "DIM installer/facade" <<<"$help1"
grep -q "DIM CLI is not installed." <<<"$help1"
version1="$(dim --version)"
grep -q "DIM installer $DIM_PACKAGE_VERSION" <<<"$version1"
grep -q "DIM CLI: not installed" <<<"$version1"

echo "[container] non-TTY clean install rejects an unreviewed optional provider before mutation"
config_path="$HOME/.config/dim/config.json"
controller_runtime="/tmp/dim-0/dim/managed"
controller_pid="$controller_runtime/controller.pid"
controller_socket="$controller_runtime/workspace/controller.sock"
mkdir -p "$(dirname "$config_path")"
printf '{"schemaVersion":1,"workspaceBackend":"sysbox"}\n' >"$config_path"
config_before="$(sha256sum "$config_path")"
if dim installer install core --with-managed \
  --host-mirror-plugin '@slop-lab/dim-host-plugin-mirrors@0.9.0' \
  >/tmp/core-refusal.out 2>/tmp/core-refusal.err; then
  echo "clean non-TTY core install unexpectedly accepted an unreviewed host plugin selection" >&2
  exit 1
fi
grep -Fq -- "must be the reviewed package '@slop-lab/dim-host-plugin-mirrors@$DIM_PACKAGE_VERSION'" /tmp/core-refusal.err
test ! -e "$HOME/.local/share/dim/runtime"
test "$(sha256sum "$config_path")" = "$config_before"

echo "[container] clean direct install stops its target before foreign-bin rollback"
mkdir -p "$HOME/.local/bin"
printf 'user-owned dim\n' >"$HOME/.local/bin/dim"
if dim installer install core --with-managed --local-bin \
  --host-mirror-plugin "@slop-lab/dim-host-plugin-mirrors@$DIM_PACKAGE_VERSION" \
  >/tmp/core-rollback.out 2>/tmp/core-rollback.err; then
  echo "clean direct install unexpectedly replaced a foreign bin file" >&2
  exit 1
fi
grep -Fq "not managed by DIM installer" /tmp/core-rollback.err
test "$(cat "$HOME/.local/bin/dim")" = "user-owned dim"
test ! -e "$HOME/.local/share/dim/runtime/current"
test ! -e "$controller_pid"
test ! -e "$controller_socket"
test "$(sha256sum "$config_path")" = "$config_before"
rm "$HOME/.local/bin/dim"

echo "[container] install the exact reviewed host plugin in the first core transaction"
dim installer install core --with-managed \
  --host-mirror-plugin "@slop-lab/dim-host-plugin-mirrors@$DIM_PACKAGE_VERSION"
if test -e "$HOME/.local/bin/dim"; then
  echo "mise-managed core install unexpectedly created a direct local bin" >&2
  exit 1
fi
mode="$(mise exec node@24 -- node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).cli.mode)" "$config_path")"
if [[ "$mode" != proxied ]]; then echo "expected proxied CLI mode, got: $mode" >&2; exit 1; fi
runtime="$HOME/.local/share/dim/runtime/current"
plugin_version="$(mise exec node@24 -- node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).dependencies['@slop-lab/dim-host-plugin-mirrors'])" "$runtime/package.json")"
if [[ "$plugin_version" != "$DIM_PACKAGE_VERSION" ]]; then echo "installed mirror plugin version mismatch: $plugin_version" >&2; exit 1; fi
mirror_enabled="$(mise exec node@24 -- node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).plugins.includes('@slop-lab/dim-host-plugin-mirrors'))" "$runtime/plugins.json")"
if [[ "$mirror_enabled" != true ]]; then echo "installed mirror plugin was not enabled" >&2; exit 1; fi

echo "[container] dim --version after install (matching versions, proxied)"
version2="$(dim --version)"
if ! grep -q "DIM CLI $DIM_PACKAGE_VERSION (via DIM installer $DIM_PACKAGE_VERSION)" <<<"$version2"; then
  echo "installed facade version output is missing the matched CLI/installer identity: $version2" >&2
  exit 1
fi
if grep -qi "warning" <<<"$version2"; then echo "installed facade version unexpectedly warned: $version2" >&2; exit 1; fi

echo "[container] dim --help proxied to the selected host-owned command surface"
help2="$(dim --help)"
if ! grep -q "Persistent, isolated development workspaces" <<<"$help2"; then echo "installed facade did not proxy host-owned help" >&2; exit 1; fi
if ! grep -q "Client commands: dim host --help; dim forward --help" <<<"$help2"; then echo "proxied host help is missing client command guidance" >&2; exit 1; fi

global_tools="$(mise ls --global)"
if grep -Eq '^node[[:space:]]' <<<"$global_tools"; then
  echo "facade bootstrap must not add Node.js to global mise configuration" >&2
  exit 1
fi

echo "[container] existing-runtime update reconnects partial clients without mutating the independent CLI"
dim controller restart
test -e "$controller_pid"
test -S "$controller_socket"
printf 'previous runtime\n' >"$runtime/rollback-sentinel"
printf 'user-owned dim\n' >"$HOME/.local/bin/dim"
cli_before_update="$(mise exec node@24 -- node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).cli))" "$config_path")"
cat >/tmp/dim-hold-partial.mjs <<'NODE'
import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";

const [socketPath, connectionLog] = process.argv.slice(2);
let stopping = false;
let socket;
let reconnecting = false;
const scheduleReconnect = () => {
  if (stopping || reconnecting) return;
  reconnecting = true;
  setImmediate(() => { reconnecting = false; reconnect(); });
};
const reconnect = () => {
  if (stopping) return;
  socket = createConnection(socketPath);
  socket.once("connect", () => {
    appendFileSync(connectionLog, "connected\n");
    socket.write("GET /healthz HTTP/1.1\r\nHost: dim-controller\r\n");
  });
  socket.once("error", () => undefined);
  socket.once("end", scheduleReconnect);
  socket.once("close", scheduleReconnect);
  socket.resume();
};
process.once("SIGTERM", () => {
  stopping = true;
  socket?.destroy();
});
reconnect();
NODE
partial_connections=/tmp/dim-partial-connections
mise exec node@24 -- node /tmp/dim-hold-partial.mjs \
  "$controller_socket" "$partial_connections" &
attacker_pid=$!
for _ in $(seq 1 100); do
  test -s "$partial_connections" && break
  sleep 0.05
done
if ! test -s "$partial_connections"; then echo "partial client did not connect to $controller_socket" >&2; exit 1; fi
connection_count_before="$(wc -l <"$partial_connections")"
controller_pid_before="$(cat "$controller_pid")"
if ! dim installer install core --with-managed --local-bin \
  >/tmp/core-update.out 2>/tmp/core-update.err; then
  cat /tmp/core-update.err >&2
  echo "existing-runtime update failed" >&2
  exit 1
fi
cat /tmp/core-update.out
cat /tmp/core-update.err >&2
controller_pid_after="$(cat "$controller_pid")"
if [[ "$controller_pid_after" == "$controller_pid_before" ]]; then echo "active controller was not restarted during host update" >&2; exit 1; fi
for _ in $(seq 1 100); do
  test "$(wc -l <"$partial_connections")" -gt "$connection_count_before" && break
  sleep 0.05
done
connection_count="$(wc -l <"$partial_connections")"
if [[ "$connection_count" -le "$connection_count_before" ]]; then
  echo "partial client did not reconnect after controller update (before=$connection_count_before after=$connection_count)" >&2
  exit 1
fi
kill "$attacker_pid"
wait "$attacker_pid" || { status=$?; [[ "$status" == 143 ]] || exit "$status"; }
if test -e "$runtime/rollback-sentinel"; then echo "host update retained a previous-runtime sentinel" >&2; exit 1; fi
if [[ "$(cat "$HOME/.local/bin/dim")" != "user-owned dim" ]]; then echo "host update changed the independent local bin" >&2; exit 1; fi
cli_after_update="$(mise exec node@24 -- node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).cli))" "$config_path")"
if [[ "$cli_after_update" != "$cli_before_update" ]]; then echo "host update changed the independent CLI selection" >&2; exit 1; fi
if ! test -e "$controller_pid"; then echo "updated controller PID is missing" >&2; exit 1; fi
if ! test -S "$controller_socket"; then echo "updated controller socket is missing" >&2; exit 1; fi
mise exec node@24 -- node -e '
  const http = require("node:http");
  const request = http.request({ socketPath: process.argv[1], path: "/healthz" }, (response) => {
    response.resume();
    response.once("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
  });
  request.once("error", (error) => { console.error(error.message); process.exit(1); });
  request.end();
' "$controller_socket"
rm "$HOME/.local/bin/dim"

echo "[container] explicit --local-bin overrides the mise auto-detected default"
dim installer install cli --local-bin
test -L "$HOME/.local/bin/dim"
readlink -f "$HOME/.local/bin/dim" | grep -q "/dim/cli/runtime/current/"

export PATH="$HOME/.local/bin:$PATH"
which_count="$(which -a dim | sort -u | wc -l)"
test "$which_count" -ge 2

echo "mise-install-smoke-ok"
SCRIPT
chmod +x "$source_dir/run.sh"

package_version="$(node -e "console.log(require('$repo_root/packages/installer/package.json').version)")"
verdaccio_package_dir="$(basename "$(dirname "$(dirname "$(readlink -f "$repo_root/tests/node_modules/verdaccio")")")")"

echo "[mise-smoke] run in $image (mise $mise_version)"
container_id="$(docker create \
  -e "PINNED_MISE_VERSION=$mise_version" \
  -e "DIM_PACKAGE_VERSION=$package_version" \
  -e "VERDACCIO_PACKAGE_DIR=$verdaccio_package_dir" \
  "$image" \
  bash /mnt/run.sh)"
docker cp "$source_dir/." "$container_id:/mnt"
docker cp "$repo_root/node_modules/.pnpm" "$container_id:/.pnpm"
docker start --attach "$container_id"
docker rm "$container_id" >/dev/null
container_id=""
