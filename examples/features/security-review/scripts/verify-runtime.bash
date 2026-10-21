#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo_root/tests"
pnpm exec tsx --conditions=dim-source ../examples/features/security-review/verify-runtime.ts
pnpm exec tsx --conditions=dim-source scenarios/harness/securityBoundaryRuntime.ts
export DIM_TEST_PROJECT_MATCHER_DOCKER=1
exec pnpm exec vitest run scenarios/harness/securityReviewProjectIntegration.test.ts --maxWorkers=1
