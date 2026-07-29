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
npm pack packages/contracts/external-url/dist --pack-destination "$package_root" >/dev/null
npm pack packages/provider/dns-cloudflare/dist --pack-destination "$package_root" >/dev/null
npm pack packages/ingress/caddy/dist --pack-destination "$package_root" >/dev/null
npm pack packages/cli/dist --pack-destination "$package_root" >/dev/null
core_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*dim-core*.tgz' -print -quit)"
cli_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*dim-cli*.tgz' -print -quit)"
contracts_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*dim-contracts-external-url*.tgz' -print -quit)"
cloudflare_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*provider-dns-cloudflare*.tgz' -print -quit)"
caddy_tarball="$(find "$package_root" -maxdepth 1 -type f -name '*ingress-caddy*.tgz' -print -quit)"
test -n "$core_tarball"
test -n "$cli_tarball"
test -n "$contracts_tarball" -a -n "$cloudflare_tarball" -a -n "$caddy_tarball"

npm install --global --prefix "$install_prefix" \
  "$core_tarball" "$contracts_tarball" "$cloudflare_tarball" "$caddy_tarball" "$cli_tarball"
echo "Installed $install_prefix/bin/dim (ensure $install_prefix/bin is in PATH)"
