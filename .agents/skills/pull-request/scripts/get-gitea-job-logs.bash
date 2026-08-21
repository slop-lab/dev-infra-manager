#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=forge-common.bash
source "$script_dir/forge-common.bash"

remote=origin
job_id=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --remote) remote="${2:?--remote requires a value}"; shift 2 ;;
    --job-id) job_id="${2:?--job-id requires a value}"; shift 2 ;;
    *) echo "usage: get-gitea-job-logs.bash --job-id ID [--remote REMOTE]" >&2; exit 2 ;;
  esac
done

[[ "$job_id" =~ ^[1-9][0-9]*$ ]] || {
  echo "get-gitea-job-logs: a positive numeric job ID is required" >&2
  exit 2
}

forge_resolve "$remote"
gitea_configure_api
gitea_api GET "/repos/$forge_owner/$forge_repo/actions/jobs/$job_id/logs"
