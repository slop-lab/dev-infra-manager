#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/git-clone-source.bash
source "$script_dir/lib/git-clone-source.bash"

suffix="$PPID-$$"
project_name="dim-self-$suffix"
workspace_name="dim-self-$suffix"
state_root="$(mktemp -d /tmp/dim-self-state.XXXXXX)"
source_root="$(mktemp -d /tmp/dim-self-source.XXXXXX)"
dim_bin="${DIM_BIN:-$PWD/packages/cli/dist/cli.js}"
project_source="$PWD"

dim() {
  if [[ -n "${DIM_BIN:-}" ]]; then
    command "$dim_bin" "$@"
  else
    node "$dim_bin" "$@"
  fi
}

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$state_root/dim.json"
export DIM_PLUGIN_HOME="$state_root/plugins"
mkdir -p "$DIM_PLUGIN_HOME"
printf '%s\n' '{"schemaVersion":1,"plugins":[]}' > "$DIM_PLUGIN_HOME/plugins.json"
bash "$script_dir/configure-user-backend.bash" runc

cleanup() {
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    dim discard "$workspace_name" --yes >/dev/null 2>&1 || true
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
        "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/api/v1/orgs/dim-$project_name" \
        >/dev/null 2>&1 || true
    fi
  fi
  find "$state_root" -depth -delete 2>/dev/null || true
  find "$source_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

dim_prepare_clone_source "$project_source" "$source_root/snapshot"
project_source="$DIM_GIT_CLONE_SOURCE"

git clone --bare "$project_source" "$source_root/project.git" >/dev/null
dim project create "$project_name" >/dev/null
root_ref="$(git -C "$project_source" rev-parse --abbrev-ref HEAD)"
dim repo add "$project_name" root "$source_root/project.git" --root --ref "$root_ref" >/dev/null
dim create "$project_name" "$workspace_name" >/dev/null

workspace_json="$(dim show "$workspace_name" --json)"
if [[ -r /dev/kvm && -w /dev/kvm ]]; then
  test "$(jq -r .kvm <<<"$workspace_json")" = "true"
  test "$(dim run "$workspace_name" kvm)" = "workspace-kvm-ok"
else
  test "$(jq -r .kvm <<<"$workspace_json")" = "false"
  dim exec "$workspace_name" -- sh -c 'test ! -e /dev/kvm'
fi
dim exec "$workspace_name" -- \
  sh -c 'test -r .dim/setup.sh && test ! -x .dim/setup.sh && test -r .dim/entrypoint.sh && test ! -x .dim/entrypoint.sh && test "$DIM_GIT_BASE_URL" = "$(jq -r .gitBaseUrl "$DIM_PROJECT_MANIFEST")"'
test "$(dim show "$workspace_name" --json | jq -r .rootRef)" = "refs/heads/$root_ref"
dim run "$workspace_name" check >/dev/null
test "$(dim run "$workspace_name" codex -- --version)" != ""
dim run "$workspace_name" verify >/dev/null

dim discard "$workspace_name" --yes >/dev/null

echo "container-self-project-smoke-ok"
