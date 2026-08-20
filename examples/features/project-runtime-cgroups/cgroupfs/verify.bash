#!/usr/bin/env bash
set -euo pipefail

manifest="${DIM_PROJECT_MANIFEST:-/run/dim/project.json}"
test "$(jq -r .runtime.cgroups.driver "$manifest")" = cgroupfs
dim-project-cgroup require
target="$(sudo --preserve-env=DIM_PROJECT_MANIFEST,DIM_CGROUP_ROOT \
  dim-project-cgroup create example-cgroupfs "$(id -u)" "$(id -g)" cpu memory pids)"
test -d "$target"
test -w "$target/cgroup.procs"
