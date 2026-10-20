#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo_root/tests"
export DIM_TEST_REVIEW_TRACE_DOCKER=1
exec pnpm exec vitest run scenarios/harness/traceNodeRuntime.test.ts scenarios/harness/trackedReviewIntegration.test.ts --maxWorkers=1
