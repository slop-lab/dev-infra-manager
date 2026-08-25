#!/usr/bin/env sh
set -eu

workspace_root=/workspace
package_root="$(mktemp -d /tmp/dim-local-packages.XXXXXX)"

cleanup() {
  find "$package_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

for repository in core plugin-dns-cloudflare plugin-external-urls; do
  test -f "$workspace_root/$repository/package.json" || {
    echo "required source repository is missing: $repository" >&2
    exit 1
  }
done

echo "[packages] build production source repositories" >&2
pnpm --dir "$workspace_root/core" run build >&2
pnpm --dir "$workspace_root/plugin-dns-cloudflare" run build >&2
pnpm --dir "$workspace_root/plugin-external-urls" run build >&2

echo "[packages] create install bundle" >&2
node "$workspace_root/project/.dim/pack-local-packages.mjs" "$package_root" >&2
tar -C "$package_root" -cf - .
