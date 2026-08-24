#!/usr/bin/env bash
set -euo pipefail

snapshot_root="${1:-snapshot}"
output="${2:-$snapshot_root/repository-set.json}"
repositories=(development root core core-development plugin-dns-cloudflare plugin-dns-cloudflare-development plugin-external-urls plugin-external-urls-development verification examples specification)

repository_path() {
  case "$1" in
    development) printf '%s' "$snapshot_root" ;;
    root) printf '%s/project' "$snapshot_root" ;;
    *) printf '%s/%s' "$snapshot_root" "$1" ;;
  esac
}

mkdir -p "$(dirname -- "$output")"
printf '{\n  "schemaVersion": 1,\n  "repositories": {\n' >"$output"
separator=""
for repository in "${repositories[@]}"; do
  path="$(repository_path "$repository")"
  commit="$(git -C "$path" rev-parse HEAD)"
  ref="$(git -C "$path" symbolic-ref --quiet --short HEAD || true)"
  [[ -n "$ref" ]] || ref="detached"
  printf '%s    "%s": {"ref": "%s", "commit": "%s"}' \
    "$separator" "$repository" "$ref" "$commit" >>"$output"
  separator=$',\n'
done
printf '\n  }\n}\n' >>"$output"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    printf '## Exact repository set\n\n'
    printf '| Repository | Checked-out ref | Commit |\n'
    printf '| --- | --- | --- |\n'
    for repository in "${repositories[@]}"; do
      path="$(repository_path "$repository")"
      commit="$(git -C "$path" rev-parse HEAD)"
      ref="$(git -C "$path" symbolic-ref --quiet --short HEAD || true)"
      [[ -n "$ref" ]] || ref="detached"
      printf '| `%s` | `%s` | `%s` |\n' "$repository" "$ref" "$commit"
    done
  } >>"$GITHUB_STEP_SUMMARY"
fi

printf 'repository-set-evidence=%s\n' "$output"
