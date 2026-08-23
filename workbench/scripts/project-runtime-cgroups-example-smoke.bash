#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-project-runtime-cgroups.XXXXXX)"
cleanup() { find "$work_dir" -depth -delete 2>/dev/null || true; }
trap cleanup EXIT

helper="$repo_root/core/images/project-workspace/project-cgroup.bash"
write_manifest() {
  local driver="$1" status="$2" reason="${3:-}"
  jq -n --arg driver "$driver" --arg status "$status" --arg reason "$reason" '
    {schemaVersion:1,runtime:{cgroups:{version:1,driver:$driver,status:$status,
      controllers:["cpu","memory","pids"]}}}
    | if $reason == "" then . else .runtime.cgroups.reason = $reason end' \
    >"$work_dir/manifest.json"
}

for driver in cgroupfs systemd; do
  write_manifest "$driver" delegated
  DIM_PROJECT_MANIFEST="$work_dir/manifest.json" bash "$helper" require
  test "$(DIM_PROJECT_MANIFEST="$work_dir/manifest.json" bash "$helper" inspect | jq -r .driver)" = "$driver"
done

write_manifest none unavailable "the nested container engine reports cgroup driver 'none'"
if DIM_PROJECT_MANIFEST="$work_dir/manifest.json" bash "$helper" require 2>"$work_dir/error"; then
  echo "unsupported cgroup boundary was accepted" >&2
  exit 1
fi
grep -q "driver 'none'" "$work_dir/error"

echo project-runtime-cgroups-example-smoke-ok
