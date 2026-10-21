#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo_root/tests"
node node_modules/vitest/vitest.mjs run scenarios/execution/multipleRepositoryExample.test.ts
