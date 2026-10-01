#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/local-preparation-state.bash" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
package_root="$repo_root/.local/dim-packages"
source_root="$repo_root/.local/production-source"
image_inspect_ref="${DIM_LOCAL_IMAGE_INSPECT_REF:?DIM_LOCAL_IMAGE_INSPECT_REF is required}"
image_record_ref="${DIM_LOCAL_IMAGE_RECORD_REF:?DIM_LOCAL_IMAGE_RECORD_REF is required}"
repositories=(core plugin-dns-cloudflare plugin-external-urls)

test -r "$package_root/packages.json"
compgen -G "$package_root/*.tgz" >/dev/null

printf 'schema=1\n'
for repository in "${repositories[@]}"; do
  source_sha="$(git -C "$source_root/$repository" rev-parse HEAD)"
  [[ "$source_sha" =~ ^[0-9a-f]{40,64}$ ]]
  printf 'source.%s=%s\n' "$repository" "$source_sha"
done

package_sha="$({
  cd -- "$package_root"
  LC_ALL=C sha256sum -- packages.json ./*.tgz
} | sha256sum | cut -d ' ' -f 1)"
[[ "$package_sha" =~ ^[0-9a-f]{64}$ ]]
printf 'packages.sha256=%s\n' "$package_sha"

image_id="$(docker image inspect --format '{{.Id}}' "$image_inspect_ref")"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
printf 'image.ref=%s\n' "$image_record_ref"
printf 'image.id=%s\n' "$image_id"
