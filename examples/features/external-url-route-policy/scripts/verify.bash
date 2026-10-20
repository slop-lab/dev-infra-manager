#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
node "$repo_root/scripts/examples/verify-route-policy.ts" "$PWD/policy-server.ts"
