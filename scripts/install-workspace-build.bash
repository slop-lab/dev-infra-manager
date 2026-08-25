#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || -z "$1" ]]; then
  echo "Usage: bash scripts/install-workspace-build.bash WORKSPACE" >&2
  exit 2
fi

workspace="$1"
work_dir="$(mktemp -d /tmp/dim-workspace-install.XXXXXX)"
archive="$work_dir/packages.tar"
package_root="$work_dir/packages"

cleanup() {
  find "$work_dir" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

if command -v mise >/dev/null 2>&1; then
  dim_command=(mise exec -- dim)
else
  dim_command=(dim)
fi

echo "[workspace] build package bundle in '$workspace'"
"${dim_command[@]}" run "$workspace" package-local >"$archive"
mkdir "$package_root"

while IFS= read -r member; do
  case "$member" in
    ./|./packages.json|./*.tgz) ;;
    *) echo "refusing unexpected package archive member: $member" >&2; exit 1 ;;
  esac
done < <(tar -tf "$archive")
while IFS= read -r metadata; do
  case "${metadata:0:1}" in
    -|d) ;;
    *) echo "refusing non-regular package archive member: $metadata" >&2; exit 1 ;;
  esac
done < <(tar -tvf "$archive")

tar --extract --file "$archive" --directory "$package_root" \
  --no-same-owner --no-same-permissions
test -f "$package_root/packages.json"

echo "[host] install package bundle"
"${dim_command[@]}" install-cli --local-packages "$package_root" --no-local-bin

echo "[host] restart the managed controller"
"${dim_command[@]}" controller restart
"${dim_command[@]}" --version
