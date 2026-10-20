#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo_root/tests"
exec pnpm exec vitest run scenarios/harness/projectReviewMatcher.test.ts scenarios/harness/securityReviewProjectIntegration.test.ts --maxWorkers=1
