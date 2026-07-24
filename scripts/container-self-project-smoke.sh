#!/usr/bin/env bash
set -euo pipefail

suffix="$PPID-$$"
repo_name="dim-self-$suffix"
workspace_name="dim-self-$suffix"
state_root="$(mktemp -d /tmp/dim-self-state.XXXXXX)"
source_root="$(mktemp -d /tmp/dim-self-source.XXXXXX)"
dim_bin="${DIM_BIN:-$PWD/apps/manager/dist/cli.js}"

export DIM_STATE_ROOT="$state_root"
export DIM_WORKSPACE_RUNTIME="${DIM_WORKSPACE_RUNTIME:-runc}"
export DIM_WORKSPACE_PRIVILEGED="${DIM_WORKSPACE_PRIVILEGED:-yes}"

cleanup() {
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    "$dim_bin" workspace discard "$workspace_name" --yes >/dev/null 2>&1 || true
  fi
  if docker container inspect dim-gitea >/dev/null 2>&1; then
    local credentials admin_username admin_password
    credentials="$(docker exec dim-gitea cat /data/dim/credentials.json 2>/dev/null || true)"
    if [[ -n "$credentials" ]]; then
      admin_username="$(printf '%s' "$credentials" | jq -r .adminUsername)"
      admin_password="$(printf '%s' "$credentials" | jq -r .adminPassword)"
      curl --fail --silent --show-error \
        --user "$admin_username:$admin_password" \
        --request DELETE \
        "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/api/v1/repos/$admin_username/$repo_name" \
        >/dev/null 2>&1 || true
    fi
  fi
  find "$state_root" -depth -delete 2>/dev/null || true
  find "$source_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

git clone --bare "$PWD" "$source_root/project.git" >/dev/null
"$dim_bin" repo register --name "$repo_name" "$source_root/project.git" >/dev/null
"$dim_bin" workspace create "$repo_name" "$workspace_name" >/dev/null

"$dim_bin" workspace exec "$workspace_name" -- \
  sh -c 'test -x .dim/setup.sh && test -x .dim/entrypoint.sh'
"$dim_bin" workspace run "$workspace_name" check >/dev/null
test "$("$dim_bin" workspace run "$workspace_name" codex -- --version)" != ""
"$dim_bin" workspace run "$workspace_name" verify >/dev/null

"$dim_bin" workspace discard "$workspace_name" --yes >/dev/null

echo "container-self-project-smoke-ok"

