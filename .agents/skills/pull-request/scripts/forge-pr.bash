#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  forge-pr.bash detect [--remote REMOTE]
  forge-pr.bash ensure-gitea --base BASE --head HEAD --title TITLE --body-file FILE [--remote REMOTE]
  forge-pr.bash wait-gitea --sha SHA [--timeout SECONDS] [--remote REMOTE]

PR_FORGE_URL overrides the public forge base URL for SSH remotes or sub-path installs.
GITEA_TOKEN optionally supplies an API token; otherwise Git credentials are used.
EOF
  exit 2
}

command_name="${1:-}"
[[ -n "$command_name" ]] || usage
shift
remote=origin
base=""
head=""
title=""
body_file=""
sha=""
timeout=3600
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --remote) remote="${2:?--remote requires a value}"; shift 2 ;;
    --base) base="${2:?--base requires a value}"; shift 2 ;;
    --head) head="${2:?--head requires a value}"; shift 2 ;;
    --title) title="${2:?--title requires a value}"; shift 2 ;;
    --body-file) body_file="${2:?--body-file requires a value}"; shift 2 ;;
    --sha) sha="${2:?--sha requires a value}"; shift 2 ;;
    --timeout) timeout="${2:?--timeout requires a value}"; shift 2 ;;
    *) usage ;;
  esac
done

for dependency in curl git jq; do
  command -v "$dependency" >/dev/null || {
    echo "forge-pr: missing dependency: $dependency" >&2
    exit 1
  }
done

remote_url="$(git remote get-url "$remote" 2>/dev/null)" || {
  echo "forge-pr: Git remote '$remote' does not exist" >&2
  exit 1
}

case "$remote_url" in
  http://*|https://*)
    remote_base="$(printf '%s\n' "$remote_url" | sed -E 's#^(https?://[^/]+).*$#\1#')"
    path="${remote_url#"$remote_base"/}"
    ;;
  ssh://*)
    remote_host="$(printf '%s\n' "$remote_url" | sed -E 's#^ssh://([^@/]+@)?([^/:]+).*$#\2#')"
    remote_base="${PR_FORGE_URL:-https://$remote_host}"
    path="$(printf '%s\n' "$remote_url" | sed -E 's#^ssh://([^@/]+@)?[^/]+/##')"
    ;;
  *@*:*)
    remote_host="$(printf '%s\n' "$remote_url" | sed -E 's#^([^@]+@)?([^:]+):.*$#\2#')"
    remote_base="${PR_FORGE_URL:-https://$remote_host}"
    path="${remote_url#*:}"
    ;;
  *)
    echo "forge-pr: remote '$remote' is not an HTTP(S) or SSH forge URL: $remote_url" >&2
    exit 1
    ;;
esac

forge_url="${PR_FORGE_URL:-$remote_base}"
forge_url="${forge_url%/}"
path="${path%.git}"
path="${path#/}"
repository="$(printf '%s\n' "$path" | awk -F/ 'NF >= 2 { print $(NF-1) "/" $NF }')"
[[ "$repository" == */* ]] || {
  echo "forge-pr: cannot derive owner/repository from remote '$remote_url'" >&2
  exit 1
}
owner="${repository%/*}"
repo="${repository#*/}"
host="$(printf '%s\n' "$forge_url" | sed -E 's#^https?://([^/]+).*$#\1#')"

provider=unknown
if [[ "$host" == github.com || "$host" == api.github.com ]]; then
  provider=github
elif curl --fail --silent --show-error --max-time 5 "$forge_url/api/v1/version" 2>/dev/null |
  jq -e '.version | type == "string"' >/dev/null 2>&1; then
  provider=gitea
fi

if [[ "$command_name" == detect ]]; then
  jq -n --arg provider "$provider" --arg remote "$remote" \
    --arg remoteUrl "$remote_url" --arg forgeUrl "$forge_url" \
    --arg repository "$repository" \
    '{provider:$provider,remote:$remote,remoteUrl:$remoteUrl,forgeUrl:$forgeUrl,repository:$repository}'
  [[ "$provider" != unknown ]] || exit 3
  exit
fi

[[ "$provider" == gitea ]] || {
  echo "forge-pr: command '$command_name' requires Gitea; detected '$provider' at $forge_url" >&2
  exit 3
}

credential_args=()
if [[ -n "${GITEA_TOKEN:-}" ]]; then
  credential_args=(--header "Authorization: token $GITEA_TOKEN")
else
  protocol="${forge_url%%://*}"
  credential_host="${forge_url#*://}"
  credential_host="${credential_host%%/*}"
  credential="$(printf 'protocol=%s\nhost=%s\n\n' "$protocol" "$credential_host" | git credential fill)" || {
    echo "forge-pr: no Git credential is available for $credential_host" >&2
    exit 1
  }
  username="$(printf '%s\n' "$credential" | sed -n 's/^username=//p')"
  password="$(printf '%s\n' "$credential" | sed -n 's/^password=//p')"
  [[ -n "$username" && -n "$password" ]] || {
    echo "forge-pr: incomplete Git credential for $credential_host" >&2
    exit 1
  }
  credential_args=(--user "$username:$password")
fi

api() {
  local method="$1" endpoint="$2"
  shift 2
  curl --fail --silent --show-error "${credential_args[@]}" \
    --request "$method" --header 'Content-Type: application/json' \
    "$@" "$forge_url/api/v1$endpoint"
}

case "$command_name" in
  ensure-gitea)
    [[ -n "$base" && -n "$head" && -n "$title" && -r "$body_file" ]] || usage
    [[ "$title" != WIP:* && "$title" != "[WIP]"* ]] || {
      echo "forge-pr: Gitea PR title must not mark the PR as draft" >&2
      exit 2
    }
    pulls="$(api GET "/repos/$owner/$repo/pulls?state=open&limit=50")"
    number="$(printf '%s' "$pulls" | jq -r --arg head "$head" --arg base "$base" \
      '[.[] | select(.head.ref == $head and .base.ref == $base)][0].number // empty')"
    payload="$(jq -n --arg title "$title" --arg head "$head" --arg base "$base" \
      --rawfile body "$body_file" '{title:$title,head:$head,base:$base,body:$body,draft:false}')"
    if [[ -n "$number" ]]; then
      response="$(api PATCH "/repos/$owner/$repo/pulls/$number" --data "$payload")"
    else
      response="$(api POST "/repos/$owner/$repo/pulls" --data "$payload")"
    fi
    printf '%s' "$response" | jq '{number,title,html_url,state,draft,head:.head.ref,base:.base.ref}'
    ;;
  wait-gitea)
    [[ "$sha" =~ ^[0-9a-fA-F]{7,64}$ && "$timeout" =~ ^[0-9]+$ ]] || usage
    deadline=$((SECONDS + timeout))
    while (( SECONDS <= deadline )); do
      response="$(api GET "/repos/$owner/$repo/commits/$sha/status")"
      state="$(printf '%s' "$response" | jq -r '.state // "pending"')"
      count="$(printf '%s' "$response" | jq -r '.total_count // 0')"
      printf '%s' "$response" | jq '{state,total_count,statuses:[.statuses[]? | {context,state:(.status // .state),description,target_url}]}'
      if [[ "$count" -gt 0 && "$state" != pending ]]; then
        [[ "$state" == success ]]
        exit
      fi
      sleep 5
    done
    echo "forge-pr: timed out waiting for Gitea CI at $sha" >&2
    exit 1
    ;;
  *) usage ;;
esac

