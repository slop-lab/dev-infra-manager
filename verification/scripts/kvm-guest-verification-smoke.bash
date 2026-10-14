#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
source "$script_dir/lib/verification-stage-runner.bash"
DIM_VERIFICATION_STAGE_ENTRYPOINT="$script_dir/kvm-guest-verification-smoke.bash"
export DIM_VERIFICATION_STAGE_ENTRYPOINT

DIM_VERIFICATION_LOG_ROOT="${DIM_KVM_GUEST_LOG_ROOT:-/tmp/dim-kvm-guest-logs/$(date -u +%Y%m%dT%H%M%SZ)-$$}"
export DIM_VERIFICATION_LOG_ROOT

guest_ready() {
  command -v node >/dev/null
  command -v pnpm >/dev/null
  command -v just >/dev/null
  docker info >/dev/null
  docker compose version >/dev/null
  systemctl is-active sysbox >/dev/null
  docker image inspect dim-backend-smoke:local >/dev/null
  test -d "$repo_root/.dim"
}

common_full() {
  cd "$repo_root"
  DIM_DOCKER_REGISTRY_MIRROR="${DIM_DOCKER_REGISTRY_MIRROR:-}" \
    DIM_TEST_REGISTRY_MIRROR_ADDRESS=10.0.2.2 JUST_UNSTABLE=1 \
    just verify full-development
}

trusted_workspace() (
  set -euo pipefail
  local suffix
  suffix="$(tr -d - </proc/sys/kernel/random/uuid)"
  local trusted="dim-kvm-trusted-$suffix" agent="dim-kvm-agent-$suffix"
  local workspace_image="dim-kvm-trusted-workspace:$suffix"
  local trusted_id="" agent_id="" workspace_image_id="" current_id="" current_label=""
  cleanup_trusted_workspace() {
    local status=$? cleanup_status=0
    trap - EXIT
    set +e
    current_id="$(sudo docker inspect --format '{{.Id}}' "$agent" 2>/dev/null)"
    if [[ -n "$current_id" ]]; then
      current_label="$(sudo docker inspect --format '{{index .Config.Labels "dev.slop-lab.dim.verification-run"}}' "$agent" 2>/dev/null)"
      if [[ -n "$agent_id" && "$current_id" == "$agent_id" && "$current_label" == "$suffix" ]]; then
        sudo docker rm -f "$current_id" >/dev/null || cleanup_status=1
      else
        cleanup_status=1
      fi
    elif [[ -n "$agent_id" ]]; then
      cleanup_status=1
    fi
    current_id="$(sudo docker inspect --format '{{.Id}}' "$trusted" 2>/dev/null)"
    if [[ -n "$current_id" ]]; then
      current_label="$(sudo docker inspect --format '{{index .Config.Labels "dev.slop-lab.dim.verification-run"}}' "$trusted" 2>/dev/null)"
      if [[ -n "$trusted_id" && "$current_id" == "$trusted_id" && "$current_label" == "$suffix" ]]; then
        sudo docker rm -f "$current_id" >/dev/null || cleanup_status=1
      else
        cleanup_status=1
      fi
    elif [[ -n "$trusted_id" ]]; then
      cleanup_status=1
    fi
    current_id="$(sudo docker image inspect --format '{{.Id}}' "$workspace_image" 2>/dev/null)"
    if [[ -n "$current_id" ]]; then
      current_label="$(sudo docker image inspect --format '{{index .Config.Labels "dev.slop-lab.dim.verification-run"}}' "$workspace_image" 2>/dev/null)"
      if [[ -n "$workspace_image_id" && "$current_id" == "$workspace_image_id" && "$current_label" == "$suffix" ]]; then
        sudo docker image rm "$workspace_image_id" >/dev/null || cleanup_status=1
      else
        cleanup_status=1
      fi
    elif [[ -n "$workspace_image_id" ]]; then
      cleanup_status=1
    fi
    if ((cleanup_status != 0)); then
      printf 'trusted workspace cleanup uncertain after body status %d\n' "$status" >&2
      exit 125
    fi
    exit "$status"
  }
  trap cleanup_trusted_workspace EXIT
  cd "$repo_root"
  ! sudo docker image inspect "$workspace_image" >/dev/null 2>&1
  pnpm --filter @slop-lab/dim-controller-proxy run build
  sudo docker build --quiet -t "$workspace_image" \
    --label "dev.slop-lab.dim.verification-run=$suffix" \
    -f core/images/project-workspace/Dockerfile . >/dev/null
  workspace_image_id="$(sudo docker image inspect --format '{{.Id}}' "$workspace_image")"
  trusted_id="$(sudo docker run -d --name "$trusted" \
    --label "dev.slop-lab.dim.verification-run=$suffix" \
    --runtime=runc --privileged --device=/dev/kvm \
    "$workspace_image" sleep infinity)"
  for _ in $(seq 1 60); do
    sudo docker exec "$trusted" docker info >/dev/null 2>&1 && break
    sleep 1
  done
  sudo docker exec "$trusted" test -r /dev/kvm
  sudo docker exec "$trusted" test -w /dev/kvm
  ! sudo docker exec "$trusted" docker info --format "{{json .Runtimes}}" | grep -q sysbox-runc
  sudo docker exec -u root "$trusted" apk add --no-cache qemu-system-x86_64 >/dev/null
  local status=0
  sudo docker exec -u root "$trusted" timeout 2 qemu-system-x86_64 \
    -machine q35,accel=kvm -cpu host -m 128 -smp 1 -nodefaults -nographic -S || status=$?
  test "$status" -eq 124
  local -a dind_mirror_flags
  if [[ -n "${DIM_DOCKER_REGISTRY_MIRROR:-}" ]]; then
    dind_mirror_flags=(
      --add-host host.docker.internal:host-gateway
      docker:29.1.3-dind
      --registry-mirror "$DIM_DOCKER_REGISTRY_MIRROR"
      --insecure-registry "${DIM_DOCKER_REGISTRY_MIRROR#http://}"
    )
  else
    dind_mirror_flags=(docker:29.1.3-dind)
  fi
  agent_id="$(sudo docker run -d --name "$agent" \
    --label "dev.slop-lab.dim.verification-run=$suffix" \
    --runtime=sysbox-runc "${dind_mirror_flags[@]}")"
  for _ in $(seq 1 60); do
    sudo docker exec "$agent" docker info >/dev/null 2>&1 && break
    sleep 1
  done
  if [[ -n "${DIM_DOCKER_REGISTRY_MIRROR:-}" ]]; then
    sudo docker exec "$agent" docker info --format '{{json .RegistryConfig.Mirrors}}' |
      grep -Fq "$DIM_DOCKER_REGISTRY_MIRROR"
  fi
  sudo docker image save dim-backend-smoke:local |
    sudo docker exec -i "$agent" docker image load >/dev/null
  sudo docker exec "$agent" docker run --rm dim-backend-smoke:local true
  test "$(sudo docker inspect -f "{{.HostConfig.Privileged}}" "$agent")" = false
)

ci_runner_boundary() (
  set -euo pipefail
  local suffix
  suffix="$(tr -d - </proc/sys/kernel/random/uuid)"
  local state_root="/tmp/dim-ci-runner-state-$suffix"
  local source_root="/tmp/dim-ci-source-$suffix"
  local project="ci-smoke-$suffix"
  local state_root_identity="" source_root_identity=""
  local runner_created=false project_created=false
  cleanup_ci_runner() {
    local status=$? cleanup_status=0
    trap - EXIT
    set +e
    cd "$repo_root"
    if [[ "$runner_created" == true ]]; then
      pnpm run --silent cli -- ci runner delete "$project" primary --yes >/dev/null 2>&1 || cleanup_status=1
    fi
    if [[ "$project_created" == true ]]; then
      pnpm run --silent cli -- project purge "$project" --yes >/dev/null 2>&1 || cleanup_status=1
    fi
    if [[ -n "$source_root_identity" ]]; then
      if [[ ! -e "$source_root" && ! -L "$source_root" ]]; then
        :
      elif [[ ! -L "$source_root" && "$(stat -Lc '%d:%i' "$source_root" 2>/dev/null)" == "$source_root_identity" ]]; then
        sudo rm -rf "$source_root" || cleanup_status=1
      else
        cleanup_status=1
      fi
    fi
    if [[ -n "$state_root_identity" ]]; then
      if [[ ! -e "$state_root" && ! -L "$state_root" ]]; then
        :
      elif [[ ! -L "$state_root" && "$(stat -Lc '%d:%i' "$state_root" 2>/dev/null)" == "$state_root_identity" ]]; then
        sudo rm -rf "$state_root" || cleanup_status=1
      else
        cleanup_status=1
      fi
    fi
    if ((cleanup_status != 0)); then
      printf 'CI boundary cleanup uncertain after body status %d\n' "$status" >&2
      exit 125
    fi
    exit "$status"
  }
  trap cleanup_ci_runner EXIT
  export DIM_STATE_ROOT="$state_root"
  export DIM_CONFIG_PATH="$state_root/config.json"
  export DIM_CI_RUNNER_CPUS=1.5
  export DIM_CI_RUNNER_MEMORY=1g
  export DIM_CI_RUNNER_PIDS=1024
  export GIT_CONFIG_GLOBAL="$state_root/gitconfig"
  [[ ! -e "$state_root" && ! -L "$state_root" && ! -e "$source_root" && ! -L "$source_root" ]]
  mkdir "$state_root"
  state_root_identity="$(stat -Lc '%d:%i' "$state_root")"
  mkdir "$source_root"
  source_root_identity="$(stat -Lc '%d:%i' "$source_root")"
  printf '%s\n' '{"schemaVersion":1,"workspaceBackend":"sysbox"}' >"$DIM_CONFIG_PATH"
  git config --file "$GIT_CONFIG_GLOBAL" user.name Smoke
  git config --file "$GIT_CONFIG_GLOBAL" user.email smoke@dim.invalid
  cd "$repo_root"
  bash examples/features/ci-runner/create-repository.bash "$source_root/repository" >/dev/null
  pnpm run --silent cli -- project create "$project" \
    --repos "$source_root/repository/root/.dim/repos.yml" --yes >/dev/null
  project_created=true
  pnpm run --silent cli -- ci runner create "$project" primary sysbox >/dev/null
  runner_created=true
  local container status
  container="$(pnpm run --silent cli -- ci runner status "$project" primary --json | jq -r .executor.containerName)"
  test "$(sudo docker inspect --format "{{.HostConfig.Runtime}}" "$container")" = sysbox-runc
  test "$(sudo docker inspect --format "{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.PidsLimit}}" "$container")" \
    = "1500000000|1073741824|1024"
  test "$(sudo docker inspect --format "{{.HostConfig.Privileged}}" "$container")" = false
  ! sudo docker inspect --format "{{json .Mounts}}" "$container" | grep -q /var/run/docker.sock
  for _ in $(seq 1 60); do
    status="$(sudo docker inspect --format "{{.State.Status}}" "$container")"
    [[ "$status" != running ]] || break
    sleep 1
  done
  test "$status" = running
)

non_root_ci() {
  cd "$repo_root"
  DIM_CI_RUNNER_EXAMPLE_ATTEMPTS=300 \
    bash verification/scripts/ci-runner-example-smoke.bash
}

verification_stage_register guest-ready guest_ready ""
verification_stage_register common-full common_full "guest-ready"
if [[ "${DIM_KVM_SKIP_TRUSTED_WORKSPACE:-0}" != 1 ]]; then
  verification_stage_register trusted-kvm-sysbox trusted_workspace "guest-ready"
fi
verification_stage_register managed-ci-boundary ci_runner_boundary "guest-ready"
verification_stage_register non-root-ci non_root_ci "guest-ready"
if [[ -n "${DIM_VERIFICATION_INTERNAL_STAGE:-}" ]]; then
  verification_stage_run_internal "$DIM_VERIFICATION_INTERNAL_STAGE"
  exit
fi
verification_stage_run
