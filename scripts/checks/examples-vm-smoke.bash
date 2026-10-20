#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$repo_root"
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || {
  printf '%s\n' 'examples VM acceptance is unavailable: accessible real /dev/kvm is required' >&2
  exit 2
}
source_sha="$(git rev-parse --verify HEAD)"
source_tree="$(git rev-parse --verify 'HEAD^{tree}')"
[[ -z "${GITHUB_SHA:-}" || "$GITHUB_SHA" == "$source_sha" ]] || {
  printf '%s\n' 'examples VM checkout does not match the requested candidate' >&2
  exit 2
}
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] || {
  printf '%s\n' 'examples VM acceptance requires a clean committed source tree' >&2
  exit 2
}
evidence="${DIM_EXAMPLES_VM_LOG_ROOT:-$repo_root/.local/checks/examples-vm-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
[[ "$evidence" == /* ]] || { printf '%s\n' 'DIM_EXAMPLES_VM_LOG_ROOT must be absolute' >&2; exit 2; }
umask 077
mkdir -p -- "$evidence"
work="$(mktemp -d /tmp/dim-examples-candidate.XXXXXXXX)"
trap 'rm -rf -- "$work"' EXIT
git bundle create "$work/candidate.bundle" HEAD
node --input-type=module - "$work/source.json" "$source_sha" "$source_tree" <<'JS'
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({ schemaVersion: 1,
  sourceSha: process.argv[3], sourceTree: process.argv[4] }) + '\n', { mode: 0o600 });
JS
cp -- "$work/source.json" "$evidence/source.json"
DIM_BOOTSTRAP_VM_LOG_ROOT="$evidence" bash scripts/checks/bootstrap-ubuntu-vm-smoke.bash \
  --source-bundle "$work/candidate.bundle" --source-manifest "$work/source.json"
