#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
: "${DIM_ROUTE_POLICY_SOCKET:?set an absolute private Unix socket path}"
exec node policy-server.ts "$DIM_ROUTE_POLICY_SOCKET"
