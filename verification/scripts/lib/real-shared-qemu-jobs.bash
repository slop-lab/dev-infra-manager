#!/usr/bin/env bash

gitea_api() {
  local method="$1" path="$2" body="${3:-}" output="${GITEA_API_OUTPUT:-/dev/stdout}"
  local arguments=(--fail --silent --show-error --user "dim-operator:$admin_password" --request "$method" --output "$output")
  if [[ -n "$body" ]]; then
    arguments+=(--header 'content-type: application/json' --data-binary "$body")
  fi
  curl "${arguments[@]}" "$gitea_api_url$path"
}

wait_for_gitea() {
  for attempt in $(seq 1 120); do
    if curl --fail --silent "$gitea_url/api/healthz" >/dev/null 2>&1; then
      return
    fi
    [[ "$attempt" -lt 120 ]] || return 1
    sleep 1
  done
}

wait_for_worker() {
  local host="$1" container="$2" authorization="$3"
  for attempt in $(seq 1 300); do
    if docker exec "$container" curl --fail --silent --header "Authorization: $authorization" \
      http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
      printf 'real-shared-qemu: %s worker authenticated with shared scheduler\n' "$host"
      return
    fi
    if ! docker container inspect "$container" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
      docker logs "$container" >&2 || true
      return 1
    fi
    [[ "$attempt" -lt 300 ]] || { docker logs "$container" >&2; return 1; }
    sleep 1
  done
}

push_repository() {
  local repository="$1"
  local remote_name="${repository##*/}"
  remote_name="${remote_name%-source}"
  env DIM_GIT_USERNAME=dim-operator DIM_GIT_TOKEN="$admin_password" GIT_TERMINAL_PROMPT=0 \
    git -C "$repository" -c credential.helper= -c "credential.helper=$credential_helper" \
      push --quiet "$repository_url/$remote_name.git" main
}

queue_workflow() {
  local host="$1" marker="$2" repository="$work_dir/jobs-source"
  mkdir -p "$repository/.gitea/workflows"
  cat >"$repository/.gitea/workflows/real-shared-qemu.yml" <<EOF
name: real-shared-qemu
on:
  push:
jobs:
  prove-host:
    runs-on: dim-qemu
    steps:
      - name: $marker
        shell: sh
        run: |
          echo $marker
          sleep 20
EOF
  git -C "$repository" add .gitea/workflows/real-shared-qemu.yml
  git -C "$repository" -c user.name='Shared QEMU verification' \
    -c user.email=shared-qemu@dim.invalid commit --quiet -m "queue $host workflow"
  push_repository "$repository"
  git -C "$repository" rev-parse HEAD
}

wait_for_workflow() {
  local host="$1" commit="$2" expected_marker="$3"
  local expected_runner="$resource_prefix-$host-qemu"
  local worker_container="$resource_prefix-$host-worker"
  local run_id="" run_state="" jobs_file="$evidence_dir/jobs-$host.json"
  local registration_file="$evidence_dir/registration-$host.json"
  local worker_log="" supervisor_failures=0
  while (( SECONDS < timeout_at )); do
    if ! worker_log="$(docker logs "$worker_container" 2>&1)"; then
      printf 'workflow %s could not inspect owned worker %s\n' "$host" "$worker_container" >&2
      return 1
    fi
    supervisor_failures="$(awk 'index($0, "qemu-ci-scheduler: shared supervisor failed: ") == 1 { count += 1 } END { print count + 0 }' <<<"$worker_log")"
    if (( supervisor_failures >= 3 )); then
      jq -cn --arg host "$host" --arg worker "$worker_container" --arg runner "$expected_runner" \
        --argjson failures "$supervisor_failures" \
        '{schemaVersion:1,host:$host,workerContainer:$worker,runnerName:$runner,sharedSupervisorFailures:$failures}' \
        >"$evidence_dir/supervisor-failures-$host.json"
      printf 'workflow %s aborted after %s shared supervisor failures from owned worker %s; sanitized evidence: %s\n' \
        "$host" "$supervisor_failures" "$worker_container" "$evidence_dir/supervisor-failures-$host.json" >&2
      return 1
    fi
    GITEA_API_OUTPUT="$work_dir/runners.json" gitea_api GET "/orgs/$organization/actions/runners"
    if jq -e --arg runner "$expected_runner" '.runners | any(.name == $runner)' "$work_dir/runners.json" >/dev/null; then
      cp "$work_dir/runners.json" "$registration_file"
    fi
    GITEA_API_OUTPUT="$work_dir/runs.json" gitea_api GET "/repos/$organization/jobs/actions/runs?limit=20"
    run_id="$(jq -r --arg commit "$commit" '[.workflow_runs[] | select(.head_sha == $commit)][0].id // empty' "$work_dir/runs.json")"
    if [[ -n "$run_id" ]]; then
      GITEA_API_OUTPUT="$jobs_file" gitea_api GET "/repos/$organization/jobs/actions/runs/$run_id/jobs"
      run_state="$(jq -r --arg commit "$commit" '[.workflow_runs[] | select(.head_sha == $commit)][0] | (.status + "|" + (.conclusion // ""))' "$work_dir/runs.json")"
      case "$run_state" in
        *\|success) break ;;
        ""|*\|) ;;
        *)
          while IFS= read -r failed_job_id; do
            if ! GITEA_API_OUTPUT="$evidence_dir/job-$host-$failed_job_id.log" \
              gitea_api GET "/repos/$organization/jobs/actions/jobs/$failed_job_id/logs"; then
              printf 'could not retrieve failed job %s log\n' "$failed_job_id" >&2
            fi
          done < <(jq -r '.jobs[] | .id | select(type == "number" and . > 0)' "$jobs_file")
          printf 'workflow %s failed: %s\n' "$host" "$run_state" >&2
          return 1
          ;;
      esac
    fi
    sleep 2
  done
  [[ "$run_state" == *'|success' ]] || { printf 'workflow %s exceeded fixture deadline\n' "$host" >&2; return 1; }
  [[ -s "$registration_file" ]]
  jq -e --arg runner "$expected_runner" '
    (.jobs | length) == 1 and
    .jobs[0].status == "completed" and
    .jobs[0].conclusion == "success" and
    .jobs[0].runner_name == $runner
  ' "$jobs_file" >/dev/null
  local job_id
  job_id="$(jq -er '.jobs[0].id' "$jobs_file")"
  GITEA_API_OUTPUT="$evidence_dir/job-$host.log" gitea_api GET "/repos/$organization/jobs/actions/jobs/$job_id/logs"
  grep -Fq "$expected_marker" "$evidence_dir/job-$host.log"
  jq -n --arg host "$host" --argjson runId "$run_id" --argjson jobId "$job_id" \
    --arg runner "$expected_runner" --arg marker "$expected_marker" \
    '{host:$host,runId:$runId,jobId:$jobId,runnerName:$runner,marker:$marker,conclusion:"success"}' \
    >"$evidence_dir/result-$host.json"
  printf 'real-shared-qemu: %s completed run=%s job=%s runner=%s marker=%s\n' \
    "$host" "$run_id" "$job_id" "$expected_runner" "$expected_marker"
}

start_worker() {
  local host="$1" asset_file="$2" token="$3"
  local host_id="$host" container="$resource_prefix-$host-worker" authorization="Bearer $(openssl rand -hex 24)"
  local prefix="$resource_prefix-$host"
  docker volume create --label dim.verification=real-shared-qemu "$prefix-data" >/dev/null
  docker volume create --label dim.verification=real-shared-qemu "$prefix-common" >/dev/null
  docker volume create --label dim.verification=real-shared-qemu "$prefix-project" >/dev/null
  host_volumes+=("$prefix-data" "$prefix-common" "$prefix-project")
  docker run --detach --name "$container" --network "$network" --runtime runc \
    --cpus 1 --memory "$((job_memory_mb + 2048))m" --pids-limit 1024 \
    --device /dev/kvm --group-add "$kvm_group_id" \
    --mount "type=volume,source=$prefix-data,target=/var/lib/dim-qemu-ci" \
    --mount "type=volume,source=$prefix-common,target=/var/lib/dim-qemu-ci-common" \
    --mount "type=volume,source=$prefix-project,target=/var/lib/dim-qemu-ci-project-cache" \
    --mount "type=bind,source=$work_dir/noop-hook.bash,target=/var/lib/dim-qemu-ci-project/cache.bash,readonly" \
    --env "GITEA_INSTANCE_URL=$gitea_runner_url" \
    --env "GITEA_RUNNER_REGISTRATION_TOKEN=$token" \
    --env "GITEA_RUNNER_NAME=$resource_prefix-$host_id-qemu" \
    --env DIM_CI_REGISTRY_CACHE_UPSTREAM=dim-registry-cache:5000 \
    --env "DIM_QEMU_CI_COMMON_IMAGE_KEY=$(jq -er .commonImageKey "$asset_file")" \
    --env "DIM_QEMU_CI_PROJECT_IMAGE_KEY=$(jq -er .projectImageKey "$asset_file")" \
    --env DIM_QEMU_CI_PROJECT_HOOK_KIND=absent \
    --env "DIM_QEMU_CI_PROJECT_HOOK_DIGEST=$(jq -er .hook.digest "$asset_file")" \
    --env DIM_QEMU_CI_PROJECT_HOOK_SOURCE_REF=refs/heads/main \
    --env DIM_QEMU_CI_PROJECT_HOOK_SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567 \
    --env "DIM_QEMU_CI_JOB_IMAGE=$job_image" --env DIM_QEMU_CI_LABELS=dim-qemu \
    --env "DIM_QEMU_CI_CAPACITY=$host" --env DIM_QEMU_CI_CPUS=1 \
    --env "DIM_QEMU_CI_MEMORY_MB=$job_memory_mb" \
    --env "DIM_QEMU_WEBHOOK_AUTHORIZATION=$authorization" \
    --env DIM_QEMU_SCHEDULER_ENDPOINT=http://scheduler:8080 \
    --env DIM_QEMU_SCHEDULER_PROJECT_ID=shared-project \
    --env "DIM_QEMU_SCHEDULER_HOST_ID=$host_id" \
    --env "DIM_QEMU_SCHEDULER_TOKEN=$scheduler_api_token" \
    "$(jq -er .supervisorImageId "$asset_file")" >/dev/null
  active_workers+=("$container")
  wait_for_worker "$host" "$container" "$authorization"
}

stop_worker() {
  local host="$1" container="$resource_prefix-$1-worker" prefix="$resource_prefix-$1"
  docker container stop --time 30 "$container" >/dev/null
  docker logs "$container" >"$evidence_dir/worker-$host.log" 2>&1 || true
  [[ "$(docker container inspect "$container" --format '{{.State.ExitCode}}')" == 0 ]] || {
    printf '%s worker did not exit cleanly\n' "$host" >&2
    return 1
  }
  docker container rm "$container" >/dev/null
  docker volume rm "$prefix-data" "$prefix-common" "$prefix-project" >/dev/null
  printf 'real-shared-qemu: removed %s worker and host-scoped volumes\n' "$host"
}
