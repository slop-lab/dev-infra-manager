#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$repo_root"
baseline_args=()
case "${1:-}" in
  --baseline-manifest) [[ "$#" == 2 && "$2" == /* ]] || exit 2; baseline_args=(--baseline-manifest "$2") ;;
  --help|-h) printf '%s\n' 'Usage: bash scripts/checks/examples-vm-smoke.bash [--preflight-only | --baseline-manifest ABSOLUTE_FILE]' 'Runs separate CP and workspace-host VMs with pinned SSH transport and exact source artifacts.' 'Default: cold installation. Explicit baselines reuse dependencies, never source/runtime state.'; exit 0 ;;
  --preflight-only) [[ "$#" == 1 ]] || exit 2; exec node scripts/checks/examples-vm-preflight.ts ;;
  '') ;;
  *) printf '%s\n' 'Unknown argument; use --help' >&2; exit 2 ;;
esac
node scripts/checks/examples-vm-preflight.ts
export DIM_PRACTICAL_CI_REQUIRED=1
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
work="$(mktemp -d "${TMPDIR:-/tmp}/dim-examples-candidate.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT
git bundle create "$work/candidate.bundle" HEAD
node scripts/checks/source-manifest.ts create "$repo_root" "$work/source.json"
cp -- "$work/source.json" "$evidence/source.json"
DIM_BOOTSTRAP_EXAMPLES_SEPARATE=1 DIM_BOOTSTRAP_VM_LOG_ROOT="$evidence" bash scripts/checks/bootstrap-ubuntu-vm-smoke.bash \
  --source-bundle "$work/candidate.bundle" --source-manifest "$work/source.json" "${baseline_args[@]}"
node tests/scenarios/selected-host/ci/verifyEvidence.ts "$evidence" "$source_sha" "$source_tree"
