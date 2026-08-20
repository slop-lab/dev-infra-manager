#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=forge-common.bash
source "$script_dir/forge-common.bash"

remote=origin
base=""
head=""
title=""
body_file=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --remote) remote="${2:?--remote requires a value}"; shift 2 ;;
    --base) base="${2:?--base requires a value}"; shift 2 ;;
    --head) head="${2:?--head requires a value}"; shift 2 ;;
    --title) title="${2:?--title requires a value}"; shift 2 ;;
    --body-file) body_file="${2:?--body-file requires a value}"; shift 2 ;;
    *) echo "usage: ensure-gitea-pr.bash --base BASE --head HEAD --title TITLE --body-file FILE [--remote REMOTE]" >&2; exit 2 ;;
  esac
done

[[ -n "$base" && -n "$head" && -n "$title" && -r "$body_file" ]] || {
  echo "ensure-gitea-pr: base, head, title, and readable body file are required" >&2
  exit 2
}
[[ "$title" != WIP:* && "$title" != "[WIP]"* ]] || {
  echo "ensure-gitea-pr: title must not mark the Gitea PR as draft" >&2
  exit 2
}

forge_resolve "$remote"
gitea_configure_api
pulls="$(gitea_api GET "/repos/$forge_owner/$forge_repo/pulls?state=open&limit=50")"
number="$(printf '%s' "$pulls" | jq -r --arg head "$head" --arg base "$base" \
  '[.[] | select(.head.ref == $head and .base.ref == $base)][0].number // empty')"
payload="$(jq -n --arg title "$title" --arg head "$head" --arg base "$base" \
  --rawfile body "$body_file" '{title:$title,head:$head,base:$base,body:$body,draft:false}')"
if [[ -n "$number" ]]; then
  response="$(gitea_api PATCH "/repos/$forge_owner/$forge_repo/pulls/$number" --data "$payload")"
else
  response="$(gitea_api POST "/repos/$forge_owner/$forge_repo/pulls" --data "$payload")"
fi
printf '%s' "$response" | jq '{number,title,html_url,state,draft,head:.head.ref,base:.base.ref}'
