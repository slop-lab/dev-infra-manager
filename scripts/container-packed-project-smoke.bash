#!/usr/bin/env bash
set -euo pipefail

package_root="$(mktemp -d /tmp/dim-packed-cli.XXXXXX)"

cleanup() {
  find "$package_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

npm pack packages/core/dist --pack-destination "$package_root" >/dev/null
npm pack packages/dim-cli/dist --pack-destination "$package_root" >/dev/null
core_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*dev-infra-manager-core*.tgz' -print -quit)"
cli_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*dim-cli*.tgz' -print -quit)"
test -n "$core_tarball"
test -n "$cli_tarball"
npm install --prefix "$package_root/install" "$core_tarball" "$cli_tarball" >/dev/null
dim_bin="$package_root/install/node_modules/.bin/dim"
test -x "$dim_bin"
test ! -e "$package_root/install/node_modules/.bin/dev-infra-manager"
"$dim_bin" --help >/dev/null

DIM_BIN="$dim_bin" bash scripts/container-project-smoke.bash
DIM_BIN="$dim_bin" bash scripts/container-multi-repo-project-smoke.bash

echo "container-packed-project-smoke-ok"
