#!/usr/bin/env bash
set -euo pipefail

package_root="$(mktemp -d /tmp/dim-packed-cli.XXXXXX)"
scaffold_root="$(mktemp -d /tmp/dim-packed-scaffold.XXXXXX)"

cleanup() {
  find "$package_root" -depth -delete 2>/dev/null || true
  find "$scaffold_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

npm pack apps/manager/dist --pack-destination "$package_root" >/dev/null
tarball="$(find "$package_root" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
test -n "$tarball"
npm install --prefix "$package_root/install" "$tarball" >/dev/null
dim_bin="$package_root/install/node_modules/.bin/dim"
test -x "$dim_bin"
"$dim_bin" --help >/dev/null

(
  cd "$scaffold_root"
  "$dim_bin" project init >/dev/null
  docker compose --file .dim/docker-compose.yml config >/dev/null
  test ! -e .dim/setup.sh
  test ! -e .dim/entrypoint.sh
  if "$dim_bin" project init >/dev/null 2>&1; then
    echo "project init overwrote an existing scaffold without --force" >&2
    exit 1
  fi
)

DIM_BIN="$dim_bin" bash scripts/container-project-smoke.sh
DIM_BIN="$dim_bin" bash scripts/container-multi-repo-project-smoke.sh

echo "container-packed-project-smoke-ok"
