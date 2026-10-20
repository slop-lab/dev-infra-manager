#!/usr/bin/env bash
set -euo pipefail
if (( $# > 1 )) || { (( $# == 1 )) && [[ "$1" != --ci ]]; }; then
  printf 'usage: check-source-native.bash [--ci]\n' >&2
  exit 2
fi
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repository_root"
source scripts/checks/lib/check-output.bash
check_output_init "${DIM_CHECK_LOG_DIR:-$repository_root/.local/checks}"
trap check_output_stop EXIT
check_output_run prerequisites bash scripts/checks/source-gate-preflight.bash
check_output_run typecheck pnpm run workspace:check
check_output_run build pnpm run workspace:build
check_output_run tests pnpm run workspace:test
check_output_run examples node scripts/examples/run.ts all verify
if [[ "${1:-}" == --ci ]]; then
  check_output_run service-fixtures pnpm --dir tests test:qemu-service
  check_output_run package-packs just --quiet verify package-packs
  check_output_run dependency-audit pnpm audit --prod
fi
printf '[check] complete stages=%s logs=%s\n' "$CHECK_OUTPUT_SEQUENCE" "$CHECK_OUTPUT_ROOT"
