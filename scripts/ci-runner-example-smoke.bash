#!/usr/bin/env bash
set -euo pipefail

# Materializes examples/features/ci-runner and verifies the documented path
# against a real managed Gitea and Sysbox runner.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
# shellcheck source=lib/local-npm-registry.bash
source "$script_dir/lib/local-npm-registry.bash"
# shellcheck source=lib/example-dim-install.bash
source "$script_dir/lib/example-dim-install.bash"

suffix="$PPID-$$"
project_name="ci-runner-example-$suffix"
runner_name="primary"
work_dir="$(mktemp -d /tmp/dim-ci-runner-example.XXXXXX)"
source_repositories="$work_dir/repositories"
source_app="$source_repositories/app"
state_root="$work_dir/state"
install_prefix="$work_dir/install"
dim_bin="$install_prefix/bin/dim"
gitea_port="${DIM_GITEA_PORT:-3300}"
organization="dim-$project_name"

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$work_dir/config/dim.json"
export DIM_DATA_HOME="$work_dir/data"
export GIT_CONFIG_GLOBAL="$work_dir/host.gitconfig"
git config --file "$GIT_CONFIG_GLOBAL" user.name "CI Runner Example"
git config --file "$GIT_CONFIG_GLOBAL" user.email "ci-runner-example@dim.invalid"
workspace_backend="${DIM_EXAMPLE_WORKSPACE_BACKEND:-runc}"
bash "$script_dir/configure-user-backend.bash" "$workspace_backend"

dim() { "$dim_bin" "$@"; }

if ! docker info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"'; then
  echo "CI runner example requires Docker with the sysbox-runc runtime" >&2
  echo "Run the cgroup portion in a clean VM with: bash verification/scripts/kvm-host-install-smoke.bash sysbox" >&2
  exit 2
fi

gitea_credentials() {
  docker exec dim-gitea cat /data/dim/credentials.json
}

gitea_api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local credentials username password
  credentials="$(gitea_credentials)"
  username="$(jq -r .adminUsername <<<"$credentials")"
  password="$(jq -r .adminPassword <<<"$credentials")"
  if [[ -n "$body" ]]; then
    curl --fail --silent --show-error \
      --user "$username:$password" \
      --header "Content-Type: application/json" \
      --request "$method" \
      --data-binary "$body" \
      "http://127.0.0.1:$gitea_port/api/v1$path"
  else
    curl --fail --silent --show-error \
      --user "$username:$password" \
      --request "$method" \
      "http://127.0.0.1:$gitea_port/api/v1$path"
  fi
}

cleanup() {
  if [[ -f "$state_root/ci-runners/$project_name/$runner_name.json" ]]; then
    dim ci runner delete "$project_name" "$runner_name" --yes >/dev/null 2>&1 || true
  fi
  if docker container inspect dim-gitea >/dev/null 2>&1; then
    gitea_api DELETE "/orgs/$organization" >/dev/null 2>&1 || true
  fi
  dim_stop_local_npm_registry
  rm -rf "$work_dir"
}
trap cleanup EXIT

cd "$repo_root"
echo "[ci-runner-example] 1. build and install DIM"
dim_install_example_cli "$repo_root" "$work_dir" "$install_prefix"
test "$DIM_EXAMPLE_DIM_BIN" = "$dim_bin"

echo "[ci-runner-example] 2. materialize and register the Project"
bash "$repo_root/examples/features/ci-runner/create-repository.bash" \
  "$source_repositories" >/dev/null
DIM_BIN="$dim_bin" bash \
  "$repo_root/examples/features/ci-runner/register-project.bash" \
  "$project_name" "$source_repositories" >/dev/null

echo "[ci-runner-example] 3. enable an isolated runner"
runner_json="$(dim ci runner create "$project_name" "$runner_name" sysbox \
  --cpus 1.5 --memory 1g --pids 512 --json)"
container_name="$(jq -r .executor.containerName <<<"$runner_json")"
test "$(jq -r .executor.phase <<<"$runner_json")" = "ready"
test "$(jq -r .executor.runtime <<<"$runner_json")" = "sysbox-runc"

inspect_json="$(docker container inspect "$container_name")"
test "$(jq -r '.[0].HostConfig.NanoCpus' <<<"$inspect_json")" = "1500000000"
test "$(jq -r '.[0].HostConfig.Memory' <<<"$inspect_json")" = "1073741824"
test "$(jq -r '.[0].HostConfig.PidsLimit' <<<"$inspect_json")" = "512"
test "$(jq -r '.[0].HostConfig.Privileged' <<<"$inspect_json")" = "false"
test "$(jq -r '.[0].HostConfig.Runtime' <<<"$inspect_json")" = "sysbox-runc"
if jq -e '.[0].Mounts[]? | select(.Destination == "/var/run/docker.sock")' \
  <<<"$inspect_json" >/dev/null; then
  echo "CI runner unexpectedly mounts the host Docker socket" >&2
  exit 1
fi

echo "[ci-runner-example] 4. open a pull request in a non-root repository"
git -C "$source_app" switch -c example-change >/dev/null
printf '\nverified through a pull request\n' >>"$source_app/message.txt"
git -C "$source_app" add message.txt
git -C "$source_app" commit -m "exercise managed CI" >/dev/null
dim x git -C "$source_app" push \
  "$(dim repo url "$project_name" app)" \
  example-change >/dev/null

pull_request="$(jq -n \
  --arg head example-change \
  --arg base main \
  --arg title "Exercise managed CI runner" \
  '{head: $head, base: $base, title: $title}')"
gitea_api POST "/repos/$organization/app/pulls" "$pull_request" >/dev/null

echo "[ci-runner-example] 5. wait for the example workflow"
workflow_result=""
workflow_attempts="${DIM_CI_RUNNER_EXAMPLE_ATTEMPTS:-120}"
for attempt in $(seq 1 "$workflow_attempts"); do
  runs="$(gitea_api GET "/repos/$organization/app/actions/runs?limit=20")"
  workflow_result="$(jq -r '
    [.workflow_runs[]
      | select(.event == "pull_request")
      | select(
          .head_branch == "example-change"
          or any(.pull_requests[]?; .head.ref == "example-change")
        )][0]
      | if . == null then "" else (.status + "|" + (.conclusion // "")) end
  ' <<<"$runs")"
  case "$workflow_result" in
    *\|success) break ;;
    ""|*\|) ;;
    *)
      echo "example workflow failed: $workflow_result" >&2
      jq '.workflow_runs[0]' <<<"$runs" >&2
      exit 1
      ;;
  esac
  sleep 2
done
if [[ "$workflow_result" != *"|success" ]]; then
  docker logs --tail 40 "$container_name" >&2 || true
  echo "example workflow timed out: ${workflow_result:-no workflow run}" >&2
  jq '.workflow_runs[:3]' <<<"$runs" >&2
  exit 1
fi

echo "[ci-runner-example] 6. disable the runner"
dim ci runner delete "$project_name" "$runner_name" --yes
test ! -e "$state_root/ci-runners/$project_name/$runner_name.json"

echo "ci-runner-example-smoke-ok"
