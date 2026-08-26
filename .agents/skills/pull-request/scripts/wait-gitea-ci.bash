#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=forge-common.bash
source "$script_dir/forge-common.bash"

remote=origin
sha=""
timeout=900
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --remote) remote="${2:?--remote requires a value}"; shift 2 ;;
    --sha) sha="${2:?--sha requires a value}"; shift 2 ;;
    --timeout) timeout="${2:?--timeout requires a value}"; shift 2 ;;
    *) echo "usage: wait-gitea-ci.bash --sha SHA [--timeout SECONDS] [--remote REMOTE]" >&2; exit 2 ;;
  esac
done

[[ "$sha" =~ ^[0-9a-fA-F]{7,64}$ && "$timeout" =~ ^[0-9]+$ ]] || {
  echo "wait-gitea-ci: valid SHA and numeric timeout are required" >&2
  exit 2
}

forge_resolve "$remote"
gitea_configure_api
deadline=$((SECONDS + timeout))
last_summary=""
while (( SECONDS <= deadline )); do
  response="$(gitea_api GET "/repos/$forge_owner/$forge_repo/commits/$sha/status")"
  summary="$(printf '%s' "$response" | jq -c '{state,total_count,statuses:[.statuses[]? | {context,state:(.status // .state),description,target_url}]}')"
  if [[ "$summary" != "$last_summary" ]]; then
    jq . <<<"$summary"
    last_summary="$summary"
  fi
  state="$(jq -r '.state // "pending"' <<<"$summary")"
  count="$(jq -r '.total_count // 0' <<<"$summary")"
  if [[ "$count" -gt 0 && "$state" != pending ]]; then
    [[ "$state" == success ]]
    exit
  fi
  sleep 5
done
echo "wait-gitea-ci: timed out waiting for Gitea CI at $sha" >&2
exit 1
