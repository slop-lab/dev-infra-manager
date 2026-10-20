#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
: "${DIM_CI_WORKER_CONFIG:?set an absolute private configured worker file}"
exec "${DIM_BIN:-dim}" ci worker "$DIM_CI_WORKER_CONFIG"
