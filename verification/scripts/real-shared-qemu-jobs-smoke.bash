#!/usr/bin/env bash
set -Eeuo pipefail
trap 'printf "real-shared-qemu: failed at %s:%s\n" "${BASH_SOURCE[0]}" "$LINENO" >&2' ERR

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script_dir="$root_dir/verification/scripts"
source "$script_dir/lib/real-shared-qemu-jobs.bash"

for command in curl docker git jq node openssl; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 2; }
done
[[ "$(uname -m)" == x86_64 ]] || { printf 'real shared QEMU jobs require x86-64\n' >&2; exit 2; }
docker info >/dev/null 2>&1 || { printf 'a reachable Docker daemon is required\n' >&2; exit 2; }
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || {
  printf 'real shared QEMU jobs require readable and writable /dev/kvm\n' >&2
  exit 2
}
available_memory_kib="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
[[ "$available_memory_kib" -ge 3500000 ]] || {
  printf 'real shared QEMU jobs require an outer guest with at least 4 GiB RAM\n' >&2
  exit 2
}

work_dir="$(mktemp -d /tmp/dim-real-shared-qemu.XXXXXX)"
suffix="$(basename "$work_dir" | tr '[:upper:]' '[:lower:]')"
resource_prefix="dim-real-shared-$suffix"
network="$resource_prefix-net"
gitea_container="$resource_prefix-gitea"
scheduler_container="$resource_prefix-scheduler"
cache_container="$resource_prefix-cache"
init_container="$resource_prefix-init"
scheduler_volume="$resource_prefix-scheduler-state"
cache_volume="$resource_prefix-cache-state"
scheduler_image="$resource_prefix-scheduler-image"
host_a_supervisor_image="$resource_prefix-host-a-supervisor-image"
host_a_state_root="$work_dir/host-a-state"
host_b_state_root="$work_dir/host-b-state"
fixture_timeout_seconds="${DIM_REAL_SHARED_QEMU_TIMEOUT_SECONDS:-3600}"
job_memory_mb="${DIM_REAL_SHARED_QEMU_JOB_MEMORY_MB:-768}"
evidence_parent="${DIM_REAL_SHARED_QEMU_EVIDENCE_ROOT:-$root_dir/.local/verification}"
evidence_dir="$evidence_parent/real-shared-qemu-$suffix"
gitea_image="gitea/gitea@sha256:7dff60d7ea6df9d0bdf78971cdb1350e9b7df3fda5f115c77afe12122887bd64"
registry_image="registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33"
job_image="docker.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce"
organization="dim-real-shared"
scheduler_api_token="$(openssl rand -hex 24)"
scheduler_webhook_token="$(openssl rand -hex 24)"
admin_password="$(openssl rand -hex 24)"
writer_password="$(openssl rand -hex 24)"
host_volumes=()
active_workers=()
supervisor_image_id=""
supervisor_image_ids=()
prior_supervisor_image="$(docker image inspect dim-qemu-ci-supervisor:0.9 --format '{{.Id}}' 2>/dev/null || true)"
kvm_group_id="$(stat -c %g /dev/kvm)"
timeout_at=$((SECONDS + fixture_timeout_seconds))
umask 077
mkdir -p "$host_a_state_root" "$host_b_state_root" "$evidence_dir"
[[ "$(realpath "$host_a_state_root")" != "$(realpath "$host_b_state_root")" ]]

cleanup_resources() {
  local status=$?
  trap - EXIT INT TERM ERR
  set +e
  local current_supervisor_image current_image_recorded=false
  current_supervisor_image="$(docker image inspect dim-qemu-ci-supervisor:0.9 --format '{{.Id}}' 2>/dev/null || true)"
  for image in "${supervisor_image_ids[@]}"; do
    if [[ "$image" == "$current_supervisor_image" ]]; then
      current_image_recorded=true
      break
    fi
  done
  if [[ "$current_supervisor_image" =~ ^sha256:[0-9a-f]{64}$ && "$current_image_recorded" == false ]]; then
    supervisor_image_ids+=("$current_supervisor_image")
  fi
  for container in "${active_workers[@]}"; do
    docker logs "$container" >"$evidence_dir/$container-cleanup.log" 2>&1
    docker container rm --force "$container" >/dev/null 2>&1
  done
  docker logs "$scheduler_container" >"$evidence_dir/scheduler.log" 2>&1
  docker logs "$gitea_container" >"$evidence_dir/gitea.log" 2>&1
  docker container rm --force "$scheduler_container" "$gitea_container" "$cache_container" "$init_container" >/dev/null 2>&1
  for volume in "${host_volumes[@]}"; do
    docker volume rm --force "$volume" >/dev/null 2>&1
  done
  docker volume rm --force "$scheduler_volume" "$cache_volume" >/dev/null 2>&1
  docker network rm "$network" >/dev/null 2>&1
  docker image rm --force "$scheduler_image" >/dev/null 2>&1
  docker image rm --force "$host_a_supervisor_image" >/dev/null 2>&1
  if [[ -n "$prior_supervisor_image" ]]; then
    docker image tag "$prior_supervisor_image" dim-qemu-ci-supervisor:0.9 >/dev/null 2>&1
  else
    docker image rm dim-qemu-ci-supervisor:0.9 >/dev/null 2>&1
  fi
  for image in "${supervisor_image_ids[@]}"; do
    [[ "$image" == "$prior_supervisor_image" ]] || docker image rm "$image" >/dev/null 2>&1
  done
  rm -rf -- "$work_dir"
  printf 'real-shared-qemu evidence: %s\n' "$evidence_dir"
  exit "$status"
}
trap cleanup_resources EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "$fixture_timeout_seconds" =~ ^[1-9][0-9]*$ ]]
[[ "$job_memory_mb" =~ ^[1-9][0-9]*$ && "$job_memory_mb" -ge 768 && "$job_memory_mb" -le 1024 ]]
printf 'real-shared-qemu: budget outer>=4GiB active-job-vm=%sMiB host-cap=56GiB\n' "$job_memory_mb"

docker network create --label dim.verification=real-shared-qemu "$network" >/dev/null
docker volume create --label dim.verification=real-shared-qemu "$scheduler_volume" >/dev/null
docker volume create --label dim.verification=real-shared-qemu "$cache_volume" >/dev/null
docker run --detach --name "$cache_container" --network "$network" --network-alias dim-registry-cache \
  --mount "type=volume,source=$cache_volume,target=/var/lib/registry" \
  --env REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io --env REGISTRY_PROXY_TTL=168h \
  --env REGISTRY_STORAGE_DELETE_ENABLED=true --env OTEL_TRACES_EXPORTER=none "$registry_image" >/dev/null
docker run --detach --name "$gitea_container" --network "$network" --network-alias gitea \
  --env GITEA__database__DB_TYPE=sqlite3 --env GITEA__security__INSTALL_LOCK=true \
  --env GITEA__server__DISABLE_SSH=true --env GITEA__service__DISABLE_REGISTRATION=true \
  --env GITEA__actions__ENABLED=true --env GITEA__webhook__ALLOWED_HOST_LIST=scheduler \
  "$gitea_image" >/dev/null
gitea_address="$(docker container inspect "$gitea_container" --format "{{with index .NetworkSettings.Networks \"$network\"}}{{.IPAddress}}{{end}}")"
[[ -n "$gitea_address" ]]
gitea_url="http://$gitea_address:3000"
gitea_api_url="$gitea_url/api/v1"
gitea_runner_url="$gitea_url"
wait_for_gitea || { docker logs "$gitea_container" >&2; exit 1; }
docker exec --user git "$gitea_container" gitea admin user create --username dim-operator \
  --password "$admin_password" --email operator@dim.invalid --admin --must-change-password=false >/dev/null
docker exec --user git "$gitea_container" gitea admin user create --username dim-workspace \
  --password "$writer_password" --email workspace@dim.invalid --must-change-password=false >/dev/null
gitea_api POST /orgs '{"username":"dim-real-shared","full_name":"dim-real-shared","visibility":"private"}' >/dev/null
gitea_api POST "/orgs/$organization/repos" '{"name":"root","private":true,"default_branch":"main"}' >/dev/null
gitea_api POST "/orgs/$organization/repos" '{"name":"jobs","private":true,"default_branch":"main"}' >/dev/null

repository_url="$gitea_url/$organization"
credential_helper='!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f'
for repository in root jobs; do
  source_path="$work_dir/$repository-source"
  git init --quiet --initial-branch=main "$source_path"
  printf '%s\n' "$repository" >"$source_path/README.md"
  git -C "$source_path" add README.md
  git -C "$source_path" -c user.name='Shared QEMU verification' \
    -c user.email=shared-qemu@dim.invalid commit --quiet -m "seed $repository"
  push_repository "$source_path"
done
gitea_api POST "/repos/$organization/root/branch_protections" \
  '{"branch_name":"main","enable_push":true,"enable_force_push":false}' >/dev/null
GITEA_API_OUTPUT="$evidence_dir/root-protection.json" gitea_api GET "/repos/$organization/root/branch_protections/main"
jq -e '.branch_name == "main" and .enable_force_push == false' "$evidence_dir/root-protection.json" >/dev/null

docker build --tag "$scheduler_image" "$root_dir/core/packages/core/dist/shared-qemu-scheduler-assets" >/dev/null
jq -n --arg api "$scheduler_api_token" --arg webhook "$scheduler_webhook_token" \
  '{schemaVersion:1,listen:{host:"0.0.0.0",port:8080},database:"/var/lib/dim-scheduler/scheduler.sqlite3",leaseSeconds:60,projects:{"shared-project":{webhookToken:$webhook,apiToken:$api,labels:["dim-qemu"]}}}' \
  >"$work_dir/scheduler.json"
docker create --name "$init_container" --user 0 --entrypoint sleep \
  --mount "type=volume,source=$scheduler_volume,target=/var/lib/dim-scheduler" "$scheduler_image" 30 >/dev/null
docker start "$init_container" >/dev/null
docker cp "$work_dir/scheduler.json" "$init_container:/var/lib/dim-scheduler/config.json"
docker exec "$init_container" chown 10001:10001 /var/lib/dim-scheduler/config.json
docker exec "$init_container" chmod 0600 /var/lib/dim-scheduler/config.json
docker rm --force "$init_container" >/dev/null
docker run --detach --name "$scheduler_container" --network "$network" --network-alias scheduler \
  --mount "type=volume,source=$scheduler_volume,target=/var/lib/dim-scheduler" "$scheduler_image" >/dev/null

node "$script_dir/real-shared-qemu-assets.mjs" "$root_dir" "$host_a_state_root" \
  "$work_dir/noop-hook.bash" "$work_dir/assets-host-a.json"
supervisor_image_id="$(jq -er .supervisorImageId "$work_dir/assets-host-a.json")"
[[ "$supervisor_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
supervisor_image_ids=("$supervisor_image_id")
docker image tag "$supervisor_image_id" "$host_a_supervisor_image"
node "$script_dir/real-shared-qemu-assets.mjs" "$root_dir" "$host_b_state_root" \
  "$work_dir/noop-hook.bash" "$work_dir/assets-host-b.json"
supervisor_image_ids+=("$(jq -er .supervisorImageId "$work_dir/assets-host-b.json")")
for image in "${supervisor_image_ids[@]}"; do
  [[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]]
done
jq -n --arg image "$supervisor_image_id" --arg prefix "$resource_prefix" \
  '{schemaVersion:1,supervisorImageId:$image,logicalHosts:[
    {hostId:"host-a",stateRoot:"host-a-state",dataVolume:($prefix+"-host-a-data"),commonVolume:($prefix+"-host-a-common"),projectVolume:($prefix+"-host-a-project")},
    {hostId:"host-b",stateRoot:"host-b-state",dataVolume:($prefix+"-host-b-data"),commonVolume:($prefix+"-host-b-common"),projectVolume:($prefix+"-host-b-project")}
  ]}' >"$evidence_dir/host-identities.json"
printf 'real-shared-qemu: production supervisor built serially for two logical host state roots\n'

hook_body="$(jq -n --arg token "Bearer $scheduler_webhook_token" \
  '{type:"gitea",active:true,events:["workflow_job"],authorization_header:$token,config:{url:"http://scheduler:8080/v1/webhooks/shared-project/workflow-job",content_type:"json"}}')"
GITEA_API_OUTPUT="$evidence_dir/webhook.json" gitea_api POST "/orgs/$organization/hooks" "$hook_body"

registration_a="$(gitea_api POST "/orgs/$organization/actions/runners/registration-token" | jq -er .token)"
start_worker host-a "$work_dir/assets-host-a.json" "$registration_a"
commit_a="$(queue_workflow host-a dim-real-shared-qemu-marker-a)"
wait_for_workflow host-a "$commit_a" dim-real-shared-qemu-marker-a
stop_worker host-a

registration_b="$(gitea_api POST "/orgs/$organization/actions/runners/registration-token" | jq -er .token)"
start_worker host-b "$work_dir/assets-host-b.json" "$registration_b"
commit_b="$(queue_workflow host-b dim-real-shared-qemu-marker-b)"
wait_for_workflow host-b "$commit_b" dim-real-shared-qemu-marker-b
stop_worker host-b

GITEA_API_OUTPUT="$evidence_dir/runs.json" gitea_api GET "/repos/$organization/jobs/actions/runs?limit=20"
jq -e --arg first "$commit_a" --arg second "$commit_b" \
  '[.workflow_runs[] | select((.head_sha == $first or .head_sha == $second) and .conclusion == "success")] | length == 2' \
  "$evidence_dir/runs.json" >/dev/null
docker exec -i "$scheduler_container" python3 - <<'PY' >"$evidence_dir/scheduler-state.json"
import json
import sqlite3
connection = sqlite3.connect("/var/lib/dim-scheduler/scheduler.sqlite3")
states = connection.execute("SELECT state, COUNT(*) FROM jobs GROUP BY state ORDER BY state").fetchall()
claims = connection.execute("SELECT COUNT(*) FROM claims").fetchone()[0]
print(json.dumps({"states": states, "claims": claims}, separators=(",", ":")))
PY
jq -e '.states == [["completed",2]] and .claims == 0' "$evidence_dir/scheduler-state.json" >/dev/null
jq -s --argjson jobVmMiB "$job_memory_mb" \
  '{schemaVersion:1,productionSources:["qemuCiRunnerSupervisorImage.js","qemuCiRunnerSupervisorAssets.js","qemuCiRunnerWebhookAsset.js","qemuCiRunnerImageAssets.js","shared-qemu-scheduler-assets"],budget:{hostCapGiB:56,outerGuestMinimumGiB:4,jobVmMiB:$jobVmMiB,maxConcurrentJobVms:1},results:.,distinctRunnerNames:([.[].runnerName] | unique | length),duplicateJobIds:(([.[].jobId] | length) != ([.[].jobId] | unique | length))}' \
  "$evidence_dir/result-host-a.json" "$evidence_dir/result-host-b.json" >"$evidence_dir/summary.json"
jq -e '.distinctRunnerNames == 2 and .duplicateJobIds == false and (.results | length == 2)' "$evidence_dir/summary.json" >/dev/null
jq -c --arg evidence "$evidence_dir" \
  '{event:"real-shared-qemu-jobs",evidence:$evidence,results:.results}' "$evidence_dir/summary.json"
printf '%s\n' real-shared-qemu-jobs-smoke-ok
