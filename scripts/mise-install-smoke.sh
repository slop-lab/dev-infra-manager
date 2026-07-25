#!/usr/bin/env bash
set -euo pipefail

# Exercises the `mise use -g 'npm:@slop-lab/install-dim@<version>'` install
# path end to end inside a disposable container: a local npm registry is
# seeded with the freshly built package tarballs (never the real npm
# registry), mise resolves/installs the installer facade through it, and the
# resulting `dim` runs the same dispatch checks the design doc requires
# (facade-only help/version, mise-detected --no-local-bin default, explicit
# --local-bin override, env var passthrough to the proxied DIM CLI).
#
# Requires Docker. Network access is required to install mise and to let the
# local registry proxy ordinary public dependencies (e.g. commander) that
# aren't part of this workspace.
#
# mise versions >= 2026.7.x refuse to install any npm package below a
# popularity threshold ("aube": refuses low-download packages), which would
# always reject an unreleased/low-adoption @slop-lab/install-dim regardless
# of registry. There is no working bypass for this in that mise generation
# yet, so this script pins an older mise release that predates the check
# purely to keep the install-path smoke test runnable; it is not evidence
# the check has been solved for real users on current mise.

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mise_version="${DIM_PINNED_MISE_VERSION:-v2026.5.0}"
image="${DIM_MISE_SMOKE_IMAGE:-node:22-bookworm}"

source_dir="$(mktemp -d /tmp/dim-mise-smoke-src.XXXXXX)"
cleanup() {
  rm -rf "$source_dir"
}
trap cleanup EXIT

cd "$repo_root"
echo "[mise-smoke] build workspace packages"
pnpm run workspace:build >/dev/null

echo "[mise-smoke] pack tarballs"
npm pack packages/core/dist --pack-destination "$source_dir" --silent >/dev/null
npm pack packages/dim-cli/dist --pack-destination "$source_dir" --silent >/dev/null
npm pack packages/install/dist --pack-destination "$source_dir" --silent >/dev/null
core_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*dev-infra-manager-core*.tgz' -print -quit)"
cli_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*dim-cli*.tgz' -print -quit)"
install_tarball="$(find "$source_dir" -maxdepth 1 -type f -name '*install-dim*.tgz' -print -quit)"
test -n "$core_tarball" && test -n "$cli_tarball" && test -n "$install_tarball"

cat > "$source_dir/verdaccio.yaml" <<'YAML'
storage: /work/registry-storage
auth:
  htpasswd:
    file: /work/htpasswd
    max_users: 1000
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@slop-lab/*':
    access: $all
    publish: $all
    unpublish: $all
  '**':
    access: $all
    publish: $all
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
listen: 0.0.0.0:4873
YAML

# Everything below runs entirely inside the container's own filesystem (the
# host directory is mounted read-only and copied once) so a root-owned
# verdaccio storage tree never ends up on the host bind mount for a
# non-root host user to clean up.
cat > "$source_dir/run.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /work
cp /mnt/*.tgz /mnt/verdaccio.yaml /work/
cd /work

echo "[container] start local npm registry"
npm install --global verdaccio@6.8.0 --silent >/dev/null 2>&1
mkdir -p /work/registry-storage
verdaccio --config /work/verdaccio.yaml --listen 0.0.0.0:4873 >/work/verdaccio.log 2>&1 &
for _ in $(seq 1 30); do
  curl -4 -sf http://127.0.0.1:4873/ >/dev/null 2>&1 && break
  sleep 1
done
curl -4 -sf http://127.0.0.1:4873/ >/dev/null || { echo "verdaccio failed to start"; cat /work/verdaccio.log; exit 1; }

resp="$(curl -s -X PUT http://127.0.0.1:4873/-/user/org.couchdb.user:smoketest \
  -H "Content-Type: application/json" \
  -d "{\"_id\":\"org.couchdb.user:smoketest\",\"name\":\"smoketest\",\"password\":\"smoketestpass\",\"type\":\"user\",\"roles\":[],\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"}")"
token="$(echo "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).token))')"
test -n "$token" && test "$token" != "undefined" || { echo "failed to register local registry user: $resp"; exit 1; }
npm config set registry http://127.0.0.1:4873 --location=global
npm config set //127.0.0.1:4873/:_authToken="$token" --location=global
# mise spawns npm without necessarily reading the npmrc file written above;
# it does read npm_config_* environment variables, which is what actually
# steers `mise use -g npm:...` at the package below.
export npm_config_registry=http://127.0.0.1:4873

echo "[container] publish local tarballs to the local registry"
npm publish /work/*dev-infra-manager-core*.tgz --registry http://127.0.0.1:4873 >/dev/null
npm publish /work/*dim-cli*.tgz --registry http://127.0.0.1:4873 >/dev/null
npm publish /work/*install-dim*.tgz --registry http://127.0.0.1:4873 >/dev/null

echo "[container] install mise ($PINNED_MISE_VERSION)"
curl -fsSL https://mise.run | MISE_VERSION="$PINNED_MISE_VERSION" sh >/tmp/mise-install.log 2>&1 \
  || { cat /tmp/mise-install.log; exit 1; }
export PATH="$HOME/.local/bin:$PATH"
mise --version

echo "[container] mise use -g npm:@slop-lab/install-dim@$DIM_PACKAGE_VERSION"
mise use -g "npm:@slop-lab/install-dim@$DIM_PACKAGE_VERSION" >/dev/null

export PATH="$HOME/.local/share/mise/shims:$PATH"
hash -r
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

echo "[container] dim install-cli with no explicit flag under mise (expect --no-local-bin default)"
dim install-cli
test ! -e "$HOME/.local/bin/dim"
config_path="$HOME/.config/slop-lab/dim.json"
mode="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).cli.mode)" "$config_path")"
test "$mode" = "proxied"

echo "[container] dim --version after install (matching versions, proxied)"
version2="$(dim --version)"
grep -q "DIM CLI $DIM_PACKAGE_VERSION (via DIM installer $DIM_PACKAGE_VERSION)" <<<"$version2"
! grep -qi "warning" <<<"$version2"

echo "[container] dim --help proxied to the real DIM CLI with facade footer"
help2="$(dim --help)"
grep -q "Isolated, persistent development workspaces" <<<"$help2"
grep -q "Running via the DIM installer facade" <<<"$help2"

echo "[container] explicit --local-bin overrides the mise auto-detected default"
dim install-cli --local-bin
test -L "$HOME/.local/bin/dim"
readlink -f "$HOME/.local/bin/dim" | grep -q "/dim/cli/$DIM_PACKAGE_VERSION/"

export PATH="$HOME/.local/bin:$PATH"
which_count="$(which -a dim | sort -u | wc -l)"
test "$which_count" -ge 2

echo "mise-install-smoke-ok"
SCRIPT
chmod +x "$source_dir/run.sh"

package_version="$(node -e "console.log(require('$repo_root/packages/install/package.json').version)")"

echo "[mise-smoke] run in $image (mise $mise_version)"
docker run --rm \
  -v "$source_dir:/mnt:ro" \
  -e "PINNED_MISE_VERSION=$mise_version" \
  -e "DIM_PACKAGE_VERSION=$package_version" \
  "$image" \
  bash /mnt/run.sh
