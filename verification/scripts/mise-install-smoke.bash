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
pnpm --dir core/packages/core/dist pack --pack-destination "$source_dir" --json >/dev/null
pnpm --dir core/packages/contracts/external-url/dist pack --pack-destination "$source_dir" --json >/dev/null
pnpm --dir core/packages/controller-proxy/dist pack --pack-destination "$source_dir" --json >/dev/null
pnpm --dir plugin-dns-cloudflare/dist pack --pack-destination "$source_dir" --json >/dev/null
pnpm --dir plugin-host-mirrors/dist pack --pack-destination "$source_dir" --json >/dev/null
pnpm --dir core/packages/cli/dist pack --pack-destination "$source_dir" --json >/dev/null
pnpm --dir core/packages/installer/dist pack --pack-destination "$source_dir" --json >/dev/null
core_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*dim-core*.tgz' -print -quit)"
cli_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*dim-cli*.tgz' -print -quit)"
install_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*dim-installer*.tgz' -print -quit)"
contracts_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*dim-contracts-external-url*.tgz' -print -quit)"
controller_proxy_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*dim-controller-proxy*.tgz' -print -quit)"
cloudflare_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*plugin-dns-cloudflare*.tgz' -print -quit)"
host_mirrors_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*plugin-host-mirrors*.tgz' -print -quit)"
test -n "$core_tarball" && test -n "$cli_tarball" && test -n "$install_tarball"
test -n "$contracts_tarball" && test -n "$controller_proxy_tarball"
test -n "$cloudflare_tarball" && test -n "$host_mirrors_tarball"

cp "$repo_root/verification/scripts/lib/local-npm-registry.bash" "$source_dir/local-npm-registry.bash"

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
dim_publish_to_local_registry \
  /work/*dim-core*.tgz \
  /work/*dim-contracts-external-url*.tgz \
  /work/*dim-controller-proxy*.tgz \
  /work/*plugin-dns-cloudflare*.tgz \
  /work/*plugin-host-mirrors*.tgz \
  /work/*dim-cli*.tgz \
  /work/*dim-installer*.tgz

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

echo "[container] non-TTY clean install refuses a missing required provider before mutation"
config_path="$HOME/.config/dim/config.json"
mkdir -p "$(dirname "$config_path")"
printf '{"schemaVersion":1,"workspaceBackend":"sysbox"}\n' >"$config_path"
config_before="$(sha256sum "$config_path")"
if dim installer install core >/tmp/core-refusal.out 2>/tmp/core-refusal.err; then
  echo "clean non-TTY core install unexpectedly succeeded without explicit host plugin selection" >&2
  exit 1
fi
grep -Fq -- "--host-mirror-plugin '@slop-lab/dim-plugin-host-mirrors@$DIM_PACKAGE_VERSION'" /tmp/core-refusal.err
test ! -e "$HOME/.local/share/dim/runtime"
test "$(sha256sum "$config_path")" = "$config_before"

echo "[container] clean direct install stops its target before foreign-bin rollback"
mkdir -p "$HOME/.local/bin"
printf 'user-owned dim\n' >"$HOME/.local/bin/dim"
if dim installer install core --local-bin \
  --host-mirror-plugin "@slop-lab/dim-plugin-host-mirrors@$DIM_PACKAGE_VERSION" \
  >/tmp/core-rollback.out 2>/tmp/core-rollback.err; then
  echo "clean direct install unexpectedly replaced a foreign bin file" >&2
  exit 1
fi
grep -Fq "not managed by DIM installer" /tmp/core-rollback.err
test "$(cat "$HOME/.local/bin/dim")" = "user-owned dim"
test ! -e "$HOME/.local/share/dim/runtime/current"
test ! -e "/tmp/dim-0/dim/controller.pid"
test ! -e "/tmp/dim-0/dim/workspace/controller.sock"
test "$(sha256sum "$config_path")" = "$config_before"
rm "$HOME/.local/bin/dim"

echo "[container] install the exact reviewed host plugin in the first core transaction"
dim installer install core \
  --host-mirror-plugin "@slop-lab/dim-plugin-host-mirrors@$DIM_PACKAGE_VERSION"
test ! -e "$HOME/.local/bin/dim"
mode="$(mise exec node@24 -- node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).cli.mode)" "$config_path")"
test "$mode" = "proxied"
runtime="$HOME/.local/share/dim/runtime/current"
plugin_version="$(mise exec node@24 -- node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).dependencies['@slop-lab/dim-plugin-host-mirrors'])" "$runtime/package.json")"
test "$plugin_version" = "$DIM_PACKAGE_VERSION"
enabled_plugin="$(mise exec node@24 -- node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).plugins[0])" "$runtime/plugins.json")"
test "$enabled_plugin" = "@slop-lab/dim-plugin-host-mirrors"

echo "[container] dim --version after install (matching versions, proxied)"
version2="$(dim --version)"
grep -q "DIM CLI $DIM_PACKAGE_VERSION (via DIM installer $DIM_PACKAGE_VERSION)" <<<"$version2"
! grep -qi "warning" <<<"$version2"

echo "[container] dim --help proxied to the real DIM CLI with facade footer"
help2="$(dim --help)"
grep -q "Isolated, persistent development workspaces" <<<"$help2"
grep -q "Running via the DIM installer facade" <<<"$help2"

if mise ls --global | grep -Eq '^node[[:space:]]'; then
  echo "facade bootstrap must not add Node.js to global mise configuration" >&2
  exit 1
fi

echo "[container] existing-runtime rollback survives partial clients on every promoted controller"
printf 'previous runtime\n' >"$runtime/rollback-sentinel"
printf 'user-owned dim\n' >"$HOME/.local/bin/dim"
config_before_upgrade_rollback="$(sha256sum "$config_path")"
cat >/tmp/dim-hold-partial.mjs <<'NODE'
import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";

const [socketPath, connectionLog] = process.argv.slice(2);
let stopping = false;
let socket;
const reconnect = () => {
  if (stopping) return;
  socket = createConnection(socketPath);
  socket.once("connect", () => {
    appendFileSync(connectionLog, "connected\n");
    socket.write("GET /healthz HTTP/1.1\r\nHost: dim-controller\r\n");
  });
  socket.once("error", () => undefined);
  socket.once("close", () => setImmediate(reconnect));
};
process.once("SIGTERM", () => {
  stopping = true;
  socket?.destroy();
});
reconnect();
NODE
partial_connections=/tmp/dim-partial-connections
mise exec node@24 -- node /tmp/dim-hold-partial.mjs \
  /tmp/dim-0/dim/workspace/controller.sock "$partial_connections" &
attacker_pid=$!
for _ in $(seq 1 100); do
  test -s "$partial_connections" && break
  sleep 0.05
done
test -s "$partial_connections"
if dim installer install core --local-bin \
  >/tmp/core-upgrade-rollback.out 2>/tmp/core-upgrade-rollback.err; then
  echo "existing-runtime install unexpectedly replaced a foreign bin file" >&2
  exit 1
fi
grep -Fq "not managed by DIM installer" /tmp/core-upgrade-rollback.err
for _ in $(seq 1 100); do
  test "$(wc -l <"$partial_connections")" -ge 3 && break
  sleep 0.05
done
test "$(wc -l <"$partial_connections")" -ge 3
kill "$attacker_pid"
wait "$attacker_pid"
test "$(cat "$runtime/rollback-sentinel")" = "previous runtime"
test "$(cat "$HOME/.local/bin/dim")" = "user-owned dim"
test "$(sha256sum "$config_path")" = "$config_before_upgrade_rollback"
test -e /tmp/dim-0/dim/controller.pid
test -S /tmp/dim-0/dim/workspace/controller.sock
mise exec node@24 -- node -e '
  const http = require("node:http");
  const request = http.request({ socketPath: process.argv[1], path: "/healthz" }, (response) => {
    response.resume();
    response.once("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
  });
  request.once("error", () => process.exit(1));
  request.end();
' /tmp/dim-0/dim/workspace/controller.sock
rm "$HOME/.local/bin/dim"

echo "[container] explicit --local-bin overrides the mise auto-detected default"
dim installer install core --local-bin
test -L "$HOME/.local/bin/dim"
readlink -f "$HOME/.local/bin/dim" | grep -q "/dim/runtime/current/"

export PATH="$HOME/.local/bin:$PATH"
which_count="$(which -a dim | sort -u | wc -l)"
test "$which_count" -ge 2

echo "mise-install-smoke-ok"
SCRIPT
chmod +x "$source_dir/run.sh"

package_version="$(node -e "console.log(require('$repo_root/core/packages/installer/package.json').version)")"
verdaccio_package_dir="$(basename "$(dirname "$(dirname "$(readlink -f "$repo_root/verification/node_modules/verdaccio")")")")"

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
