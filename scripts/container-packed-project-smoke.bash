#!/usr/bin/env bash
set -euo pipefail

package_root="$(mktemp -d /tmp/dim-packed-cli.XXXXXX)"

cleanup() {
  find "$package_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

bash scripts/pack-local-packages.bash "$package_root" >/dev/null
core_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*dim-core*.tgz' -print -quit)"
cli_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*dim-cli*.tgz' -print -quit)"
contracts_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*dim-contracts-external-url*.tgz' -print -quit)"
cloudflare_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*provider-dns-cloudflare*.tgz' -print -quit)"
test -n "$core_tarball"
test -n "$cli_tarball"
test -n "$contracts_tarball" -a -n "$cloudflare_tarball"
npm install --silent --prefix "$package_root/install" \
  "$core_tarball" "$contracts_tarball" "$cloudflare_tarball" "$cli_tarball" >/dev/null
dim_bin="$package_root/install/node_modules/.bin/dim"
test -x "$dim_bin"
test ! -e "$package_root/install/node_modules/.bin/dev-infra-manager"
"$dim_bin" --help >/dev/null

export DIM_PLUGIN_HOME="$package_root/plugins"
mkdir -p "$DIM_PLUGIN_HOME"
printf '%s\n' '{"schemaVersion":1,"plugins":[]}' > "$DIM_PLUGIN_HOME/plugins.json"

DIM_BIN="$dim_bin" bash scripts/container-project-smoke.bash
DIM_BIN="$dim_bin" bash scripts/container-multi-repo-project-smoke.bash

echo "container-packed-project-smoke-ok"
