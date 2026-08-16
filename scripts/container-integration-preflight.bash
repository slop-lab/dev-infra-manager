#!/usr/bin/env bash
set -euo pipefail

docker info >/dev/null

cgroup_driver="$(docker info --format '{{.CgroupDriver}}')"
security_options="$(docker info --format '{{json .SecurityOptions}}')"

if [[ "$cgroup_driver" == none && "$security_options" == *rootless* ]]; then
  cat >&2 <<'EOF'
error: the full container integration gate cannot run on a rootless Docker
daemon without cgroup delegation. It starts a privileged DIM workspace and
then exercises that workspace's nested runtime; the nested daemon cannot
create its cgroup subtree in this environment.

Run 'just verify-agent' inside DIM's development agent to verify the source,
packages, and its private rootless Docker sidecar. Run 'just verify-container'
on a rootful Docker host or a rootless host with working cgroup v2 delegation.
EOF
  exit 1
fi
