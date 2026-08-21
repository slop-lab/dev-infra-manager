#!/usr/bin/env bash
set -euo pipefail

manifest="${DIM_PROJECT_MANIFEST:-/run/dim/project.json}"
test "$(jq -r .runtime.cgroups.status "$manifest")" = unavailable
if dim-project-cgroup require >/dev/null 2>&1; then
  echo "unavailable project runtime cgroups were accepted" >&2
  exit 1
fi
