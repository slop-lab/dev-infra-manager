#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
exec pnpm --dir "$root/tests" exec vitest run scenarios/selected-host/config.test.ts scenarios/selected-host/profilePreparation.test.ts scenarios/selected-host/applicationEndpoint.test.ts scenarios/selected-host/isolatedUpdate.test.ts --maxWorkers=1
