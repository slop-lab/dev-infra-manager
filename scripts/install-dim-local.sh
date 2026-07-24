#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
package_root="$(mktemp -d /tmp/dim-local-install.XXXXXX)"
install_prefix="${DIM_INSTALL_PREFIX:-$HOME/.local}"

cleanup() {
  find "$package_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

cd "$repo_root"
pnpm run workspace:build
npm pack packages/core/dist --pack-destination "$package_root" >/dev/null
npm pack packages/dim-cli/dist --pack-destination "$package_root" >/dev/null
core_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*dev-infra-manager-core*.tgz' -print -quit)"
cli_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*dim-cli*.tgz' -print -quit)"
test -n "$core_tarball"
test -n "$cli_tarball"

npm install --global --prefix "$install_prefix" "$core_tarball" "$cli_tarball"
echo "Installed $install_prefix/bin/dim (ensure $install_prefix/bin is in PATH)"

