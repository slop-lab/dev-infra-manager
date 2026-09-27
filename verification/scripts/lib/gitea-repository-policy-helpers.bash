#!/usr/bin/env bash

cleanup() {
  docker container rm --force "$gitea_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$work_dir"
}

fail() {
  printf 'gitea-repository-policy: %s\n' "$1" >&2
  exit 1
}

api_status() {
  local username="$1" password="$2" method="$3" path="$4" body="$5" output="$6"
  local arguments=(
    --silent --show-error --user "$username:$password"
    --header 'content-type: application/json' --request "$method"
    --output "$output" --write-out '%{http_code}'
  )
  if [[ -n "$body" ]]; then
    arguments+=(--data "$body")
  fi
  curl "${arguments[@]}" "$gitea_api_url$path"
}

expect_api_status() {
  local expected="$1" label="$2" username="$3" password="$4" method="$5" path="$6" body="${7:-}"
  local output="$work_dir/api-$label.json" status
  status="$(api_status "$username" "$password" "$method" "$path" "$body" "$output")"
  if [[ "$status" != "$expected" ]]; then
    printf 'gitea-repository-policy: %s returned HTTP %s, expected %s\n' "$label" "$status" "$expected" >&2
    jq -c '{message,url}' "$output" >&2 2>/dev/null || true
    exit 1
  fi
  printf '%s' "$output"
}

wait_for_pull_mergeable() {
  local pull_number="$1" output
  for attempt in $(seq 1 60); do
    output="$(expect_api_status 200 "mergeable-$pull_number" "$admin_username" "$admin_password" GET \
      "/repos/$organization/$repository/pulls/$pull_number")"
    if jq -e '.mergeable == true' "$output" >/dev/null; then
      return
    fi
    [[ "$attempt" -lt 60 ]] || fail "pull request $pull_number did not become mergeable"
    sleep 0.2
  done
}

wait_for_branch() {
  local branch="$1" output status
  output="$work_dir/api-branch-$branch.json"
  for attempt in $(seq 1 60); do
    status="$(api_status "$admin_username" "$admin_password" GET \
      "/repos/$organization/$repository/branches/$branch" '' "$output")"
    if [[ "$status" == 200 ]] && jq -e --arg branch "$branch" '.name == $branch' "$output" >/dev/null; then
      return
    fi
    [[ "$status" == 404 ]] || fail "inspect branch $branch returned HTTP $status"
    [[ "$attempt" -lt 60 ]] || fail "branch $branch did not become visible through Gitea"
    sleep 0.2
  done
}

git_as() {
  local username="$1" password="$2"
  shift 2
  env DIM_GIT_USERNAME="$username" DIM_GIT_TOKEN="$password" GIT_TERMINAL_PROMPT=0 GIT_MASTER=1 \
    git -c credential.helper= -c "credential.helper=$credential_helper" "$@"
}

remote_main_sha() {
  local result
  result="$(git_as "$admin_username" "$admin_password" ls-remote "$repository_url" refs/heads/main)"
  [[ "$result" == *$'\trefs/heads/main' ]] || fail 'main was not advertised by the disposable repository'
  printf '%s\n' "${result%%$'\t'*}"
}

assert_rejected_push() {
  local label="$1" username="$2" password="$3" directory="$4" expected="$5"
  local before after log="$work_dir/$label-push.log"
  before="$(remote_main_sha)"
  if git_as "$username" "$password" -C "$directory" push origin main >"$log" 2>&1; then
    fail "$label unexpectedly pushed main"
  fi
  grep -Fq -- "$expected" "$log" || {
    printf 'gitea-repository-policy: %s rejection was not the expected policy error\n' "$label" >&2
    perl -pe 's#https?://[^/@:]+:[^/@]+@#http://REDACTED@#g' "$log" >&2
    exit 1
  }
  after="$(remote_main_sha)"
  [[ "$after" == "$before" ]] || fail "$label changed main despite a rejected push"
  printf 'gitea-repository-policy: %s denied\n' "$label"
}
