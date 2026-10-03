#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
gitea_image="gitea/gitea@sha256:7dff60d7ea6df9d0bdf78971cdb1350e9b7df3fda5f115c77afe12122887bd64"
job_image="docker.io/library/ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517"
runner_tag="dev-infra-manager-ci-runner:act-runner-minimal-v2"
registry_cache="dim-registry-cache"
control_network="dim-control"
cache_volume="dim-registry-cache-data"
pool_pid=""
worker_pid=""
runner_logs_pid=""
created_runner_image_id=""
cache_id_created=""
network_id_created=""
cache_volume_created=""
umask 077

for command in curl docker git jq node openssl; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 2; }
done
[[ -r "$repo_root/core-development/node_modules/tsx/dist/loader.mjs" ]] || {
  printf '%s\n' 'ordinary-ci-pool-live requires the installed development dependencies' >&2
  exit 2
}
dim_cli=(
  node --import "$repo_root/core-development/node_modules/tsx/dist/loader.mjs"
  "$repo_root/core/packages/cli/src/cli.ts"
)
dim() {
  "${dim_cli[@]}" "$@"
}
docker info >/dev/null
docker info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"' || {
  printf '%s\n' 'ordinary-ci-pool-live requires Docker with sysbox-runc' >&2
  exit 2
}
work_dir="$(mktemp -d /tmp/dim-ordinary-ci-pool-live.XXXXXX)"
suffix="$(basename "$work_dir")"
gitea_container="dim-ordinary-gitea-$suffix"
gitea_alias="ordinary-gitea-$suffix"

resource_id() {
  local type="$1" name="$2"
  docker "$type" inspect "$name" --format '{{.Id}}' 2>/dev/null || true
}

cache_id_before="$(resource_id container "$registry_cache")"
network_id_before="$(resource_id network "$control_network")"
volume_name_before="$(docker volume inspect "$cache_volume" --format '{{.Name}}' 2>/dev/null || true)"
runner_image_before="$(docker image inspect "$runner_tag" --format '{{.Id}}' 2>/dev/null || true)"

cleanup_managed_resource() {
  local type="$1" name="$2" before="$3" created="$4" resource="$5" current
  [[ -z "$before" && -n "$created" ]] || return 0
  if [[ "$type" == container ]]; then
    current="$(docker container inspect "$name" --format '{{.Id}}|{{index .Config.Labels "dim.managed"}}|{{index .Config.Labels "dim.resource"}}' 2>/dev/null || true)"
    [[ "$current" == "$created|true|$resource" ]] || return 0
    docker container rm --force "$created" >/dev/null 2>&1
  elif [[ "$type" == network ]]; then
    current="$(docker network inspect "$name" --format '{{.Id}}|{{index .Labels "dim.managed"}}|{{index .Labels "dim.resource"}}' 2>/dev/null || true)"
    [[ "$current" == "$created|true|$resource" ]] || return 0
    docker network rm "$name" >/dev/null 2>&1
  else
    current="$(docker volume inspect "$name" --format '{{.Name}}|{{index .Labels "dim.managed"}}|{{index .Labels "dim.resource"}}' 2>/dev/null || true)"
    [[ "$current" == "$created|true|$resource" ]] || return 0
    docker volume rm "$name" >/dev/null 2>&1
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$worker_pid" ]]; then
    kill "$worker_pid" >/dev/null 2>&1 || true
    wait "$worker_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$runner_logs_pid" ]]; then
    kill "$runner_logs_pid" >/dev/null 2>&1 || true
    wait "$runner_logs_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$pool_pid" ]]; then
    kill "$pool_pid" >/dev/null 2>&1 || true
    wait "$pool_pid" >/dev/null 2>&1 || true
  fi
  docker container rm --force "$gitea_container" >/dev/null 2>&1 || true
  cleanup_managed_resource container "$registry_cache" "$cache_id_before" "$cache_id_created" registry-cache || status=1
  cleanup_managed_resource volume "$cache_volume" "$volume_name_before" "$cache_volume_created" registry-cache-data || status=1
  cleanup_managed_resource network "$control_network" "$network_id_before" "$network_id_created" network || status=1
  if [[ -z "$runner_image_before" && -n "$created_runner_image_id" ]]; then
    docker image rm --force "$runner_tag" "$created_runner_image_id" >/dev/null 2>&1 || true
  fi
  if [[ "$status" -eq 0 || "${DIM_ORDINARY_POOL_PRESERVE_EVIDENCE:-0}" != 1 ]]; then
    rm -rf -- "$work_dir"
  else
    printf 'ordinary CI pool evidence retained at %s\n' "$work_dir" >&2
  fi
  if [[ "$status" -eq 0 ]]; then
    printf '%s\n' ordinary-ci-pool-live-cleanup-ok
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'printf "ordinary CI pool smoke failed at line %s\n" "$LINENO" >&2' ERR

if [[ -z "$network_id_before" ]]; then
  network_id_created="$(docker network create --label dim.managed=true --label dim.resource=network "$control_network")"
elif [[ "$(docker network inspect "$control_network" --format '{{index .Labels "dim.managed"}}')" != true ]]; then
  printf "Docker network '%s' exists but is not managed by dim\n" "$control_network" >&2
  exit 1
fi

admin_password="$(openssl rand -hex 24)"
writer_password="$(openssl rand -hex 24)"
host_a_token="$(openssl rand -hex 24)"
host_b_token="$(openssl rand -hex 24)"
registrar_token="$(openssl rand -hex 24)"

docker run --detach --name "$gitea_container" \
  --label dim.verification=ordinary-ci-pool-live \
  --publish 127.0.0.1::3000 \
  --add-host host.docker.internal:host-gateway \
  --env GITEA__actions__ENABLED=true \
  --env GITEA__database__DB_TYPE=sqlite3 \
  --env GITEA__security__INSTALL_LOCK=true \
  --env GITEA__server__DISABLE_SSH=true \
  --env GITEA__service__DISABLE_REGISTRATION=true \
  --env GITEA__webhook__ALLOWED_HOST_LIST=host.docker.internal \
  "$gitea_image" >/dev/null
docker network connect --alias "$gitea_alias" "$control_network" "$gitea_container"
gitea_port="$(docker port "$gitea_container" 3000/tcp | jq -Rrs 'split("\n") | map(select(length > 0)) | last | split(":") | last')"
[[ "$gitea_port" =~ ^[0-9]+$ ]]
gitea_url="http://127.0.0.1:$gitea_port"

for attempt in $(seq 1 90); do
  curl --fail --silent "$gitea_url/api/healthz" >/dev/null 2>&1 && break
  if [[ "$attempt" -eq 90 ]]; then
    docker logs "$gitea_container" >&2
    exit 1
  fi
  sleep 1
done

docker exec --user git "$gitea_container" gitea admin user create \
  --username dim-operator --password "$admin_password" --email operator@dim.invalid \
  --admin --must-change-password=false >/dev/null
docker exec --user git "$gitea_container" gitea admin user create \
  --username dim-workspace --password "$writer_password" --email workspace@dim.invalid \
  --must-change-password=false >/dev/null

gitea_api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl --fail --silent --show-error --user "dim-operator:$admin_password" \
      --header 'content-type: application/json' --request "$method" --data-binary "$body" \
      "$gitea_url/api/v1$path"
  else
    curl --fail --silent --show-error --user "dim-operator:$admin_password" \
      --request "$method" "$gitea_url/api/v1$path"
  fi
}

alpha_org="$(gitea_api POST /orgs '{"username":"dim-alpha","full_name":"DIM alpha","visibility":"private"}')"
beta_org="$(gitea_api POST /orgs '{"username":"dim-beta","full_name":"DIM beta","visibility":"private"}')"
alpha_org_id="$(jq -er '.id | select(type == "number" and . > 0)' <<<"$alpha_org")"
beta_org_id="$(jq -er '.id | select(type == "number" and . > 0)' <<<"$beta_org")"
[[ "$alpha_org_id" != "$beta_org_id" ]]
gitea_api POST /orgs/dim-alpha/repos '{"name":"app","private":true,"auto_init":false}' >/dev/null
gitea_api POST /orgs/dim-beta/repos '{"name":"app","private":true,"auto_init":false}' >/dev/null

pool_port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"0.0.0.0",()=>{console.log(s.address().port);s.close()})')"
pool_endpoint="http://127.0.0.1:$pool_port"
pool_webhook_base="http://host.docker.internal:$pool_port"
pool_config="$work_dir/pool-service.json"
jq -n \
  --arg database "$work_dir/pool.sqlite3" --arg image "$job_image" --arg webhook_base "$pool_webhook_base" \
  --arg registrar_token "$registrar_token" \
  --arg host_a_token "$host_a_token" --arg host_b_token "$host_b_token" \
  --argjson port "$pool_port" --argjson alpha_id "$alpha_org_id" --argjson beta_id "$beta_org_id" \
  '{schemaVersion:2,listen:{host:"0.0.0.0",port:$port},serviceId:"ordinary-live",database:$database,jobImage:$image,webhookBaseUrl:$webhook_base,registrarToken:$registrar_token,admissionLeaseMilliseconds:3600000,hosts:[{hostId:"host-a",token:$host_a_token,capacities:["primary"]},{hostId:"host-b",token:$host_b_token,capacities:["primary"]}]}' \
  >"$pool_config"
chmod 0600 "$pool_config"
dim ci ordinary-pool service run "$pool_config" >"$work_dir/pool.log" 2>&1 &
pool_pid=$!
for attempt in $(seq 1 60); do
  curl --fail --silent "$pool_endpoint/healthz" >/dev/null 2>&1 && break
  if ! kill -0 "$pool_pid" >/dev/null 2>&1 || [[ "$attempt" -eq 60 ]]; then
    cat "$work_dir/pool.log" >&2
    exit 1
  fi
  sleep 0.5
done

admit_project() {
  local project_id="$1" project_name="$2" organization_id="$3"
  jq -n --arg project_id "$project_id" --arg project_name "$project_name" \
    --arg organization "dim-$project_name" --arg image "$job_image" \
    --arg source_commit "$(printf 'a%.0s' {1..40})" --arg config_digest "$(printf 'b%.0s' {1..64})" \
    --argjson organization_id "$organization_id" \
    '{projectId:$project_id,projectName:$project_name,organization:$organization,organizationId:$organization_id,sourceRef:"refs/heads/main",sourceCommit:$source_commit,configDigest:$config_digest,jobImage:$image,runnerLabels:["dim-ordinary"]}' \
    | curl --fail --silent --show-error --header "Authorization: Bearer $registrar_token" \
      --header 'content-type: application/json' --data-binary @- "$pool_endpoint/v1/admissions"
}
alpha_admission="$(admit_project project-alpha alpha "$alpha_org_id")"
beta_admission="$(admit_project project-beta beta "$beta_org_id")"
alpha_webhook_token="$(jq -er '.webhookToken' <<<"$alpha_admission")"
beta_webhook_token="$(jq -er '.webhookToken' <<<"$beta_admission")"

create_hook() {
  local organization="$1" project_id="$2" token="$3" response
  response="$(jq -n --arg url "$pool_webhook_base/v1/webhooks/$project_id/workflow-job" \
    --arg authorization "Bearer $token" \
    '{type:"gitea",active:true,events:["workflow_job"],authorization_header:$authorization,config:{url:$url,content_type:"json"}}')"
  gitea_api POST "/orgs/$organization/hooks" "$response"
}

alpha_hook="$(create_hook dim-alpha project-alpha "$alpha_webhook_token")"
beta_hook="$(create_hook dim-beta project-beta "$beta_webhook_token")"
alpha_hook_id="$(jq -er '.id | select(type == "number" and . > 0)' <<<"$alpha_hook")"
beta_hook_id="$(jq -er '.id | select(type == "number" and . > 0)' <<<"$beta_hook")"
for organization in dim-alpha dim-beta; do
  hooks="$(gitea_api GET "/orgs/$organization/hooks")"
  jq -e 'length == 1 and .[0].active == true and (.[] | .events | index("workflow_job") != null)' <<<"$hooks" >/dev/null
done

write_host_files() {
  local host="$1" token="$2" host_root
  host_root="$work_dir/$host"
  mkdir -p "$host_root/config/dim" "$host_root/state"
  printf '%s\n' '{"schemaVersion":1,"workspaceBackend":"sysbox"}' >"$host_root/config/dim/config.json"
  jq -n \
    --arg host "$host" --arg api "$gitea_url/api/v1" --arg base "$gitea_url" \
    --arg runner "http://$gitea_alias:3000" --arg admin "$admin_password" --arg writer "$writer_password" \
    --argjson alpha_id "$alpha_org_id" --argjson beta_id "$beta_org_id" \
    '{schemaVersion:1,transport:"isolated-http",hostId:$host,apiBaseUrl:$api,hostBaseUrl:$base,workspaceBaseUrl:$base,runnerBaseUrl:$runner,credentials:{adminUsername:"dim-operator",adminPassword:$admin,writerUsername:"dim-workspace",writerPassword:$writer,maintainerUsername:"dim-operator",maintainerPassword:$admin},projects:{alpha:{id:"project-alpha",gitNamespace:"dim-alpha",giteaOrganizationId:$alpha_id},beta:{id:"project-beta",gitNamespace:"dim-beta",giteaOrganizationId:$beta_id}}}' \
    >"$host_root/gitea.json"
  jq -n --arg endpoint "$pool_endpoint" --arg host "$host" --arg token "$token" --arg image "$job_image" \
    '{schemaVersion:2,transport:"loopback-http",endpoint:$endpoint,hostId:$host,token:$token,expectedServiceId:"ordinary-live",expectedJobImage:$image}' \
    >"$host_root/pool.json"
  chmod 0600 "$host_root/config/dim/config.json" "$host_root/gitea.json" "$host_root/pool.json"
}
write_host_files host-a "$host_a_token"
write_host_files host-b "$host_b_token"

assert_no_local_projects() {
  local host="$1" project_dir
  project_dir="$work_dir/$host/state/projects"
  [[ ! -d "$project_dir" ]] || ! compgen -G "$project_dir/*.json" >/dev/null
}
assert_no_local_projects host-a
assert_no_local_projects host-b

credential_helper='!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f'
create_workflow() {
  local organization="$1" marker="$2" source
  source="$work_dir/source-$organization"
  git init --quiet --initial-branch=main "$source"
  git -C "$source" config user.name 'Ordinary pool verification'
  git -C "$source" config user.email ordinary-pool@dim.invalid
  mkdir -p "$source/.gitea/workflows"
  cat >"$source/.gitea/workflows/pooled.yml" <<EOF
name: pooled-$marker
on: [push]
jobs:
  verify:
    runs-on: dim-ordinary
    steps:
      - name: verify isolated disposable job
        run: |
          set -eu
          test ! -S /var/run/docker.sock
          test ! -e /dev/kvm
          printf 'workflow-evidence organization=$organization marker=$marker docker_socket=absent kvm=absent\n'
          sleep 15
EOF
  printf '%s\n' "$marker" >"$source/evidence.txt"
  git -C "$source" add .
  git -C "$source" commit --quiet -m "queue $marker pooled workflow"
  env DIM_GIT_USERNAME=dim-operator DIM_GIT_TOKEN="$admin_password" GIT_TERMINAL_PROMPT=0 \
    git -C "$source" -c credential.helper= -c "credential.helper=$credential_helper" \
    push --quiet "$gitea_url/$organization/app.git" main
}

queued_job_id() {
  local project_id="$1"
  node --input-type=module - "$work_dir/pool.sqlite3" "$project_id" <<'EOF'
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2], { readOnly: true });
const row = database.prepare("SELECT job_id FROM queued_jobs WHERE project_id = ? ORDER BY sequence LIMIT 1").get(process.argv[3]);
database.close();
if (row) process.stdout.write(`${row.job_id}\n`);
EOF
}

wait_for_webhook_queue() {
  local project_id="$1" job_id=""
  for attempt in $(seq 1 90); do
    job_id="$(queued_job_id "$project_id")"
    [[ -n "$job_id" ]] && { printf '%s\n' "$job_id"; return; }
    sleep 1
  done
  docker logs --tail 80 "$gitea_container" >&2 || true
  printf 'organization webhook did not queue %s\n' "$project_id" >&2
  return 1
}

run_worker() {
  local host="$1" project="$2" organization="$3" hook_id="$4" queued_id="$5"
  local host_root="$work_dir/$host" worker_log="$work_dir/worker-$host.log" container_id inspect
  local cache_before cache_after runner_image_override=()
  cache_before="$(docker logs "$registry_cache" 2>&1 | grep -c '/v2/library/ubuntu/' || true)"
  if [[ -n "$runner_image_before" || -n "$created_runner_image_id" ]]; then
    runner_image_override=("DIM_CI_RUNNER_IMAGE=${created_runner_image_id:-$runner_image_before}")
  fi
  env HOME="$host_root" XDG_CONFIG_HOME="$host_root/config" DIM_STATE_ROOT="$host_root/state" \
    DIM_GITEA_CONNECTION_FILE="$host_root/gitea.json" \
    DIM_ORDINARY_CI_POOL_CONNECTION_FILE="$host_root/pool.json" \
    DIM_CI_RUNNER_CPUS=1.25 DIM_CI_RUNNER_MEMORY=768m DIM_CI_RUNNER_PIDS=256 \
    "${runner_image_override[@]}" \
    "${dim_cli[@]}" ci ordinary-pool worker run-once primary >"$worker_log" 2>&1 &
  worker_pid=$!
  for attempt in $(seq 1 180); do
    container_id="$(docker container ls \
      --filter label=dim.resource=ci-ordinary-job --filter "label=dim.host=$host" \
      --format '{{.ID}}')"
    [[ -n "$container_id" ]] && break
    if ! kill -0 "$worker_pid" >/dev/null 2>&1; then
      cat "$worker_log" >&2
      return 1
    fi
    sleep 1
  done
  [[ -n "$container_id" ]] || { printf 'runner container for %s did not appear\n' "$host" >&2; return 1; }
  cache_id_created="$(resource_id container "$registry_cache")"
  cache_volume_created="$(docker volume inspect "$cache_volume" --format '{{.Name}}' 2>/dev/null || true)"
  [[ "$(wc -l <<<"$container_id")" -eq 1 ]]
  inspect="$(docker container inspect "$container_id")"
  jq -e '.[0].HostConfig.Runtime == "sysbox-runc"
    and .[0].HostConfig.NanoCpus == 1250000000
    and .[0].HostConfig.Memory == 805306368
    and .[0].HostConfig.PidsLimit == 256
    and .[0].HostConfig.Privileged == false
    and ((.[0].HostConfig.Devices // []) | length == 0)
    and ([.[0].Mounts[]? | select(.Source == "/var/run/docker.sock" or .Destination == "/var/run/docker.sock")] | length == 0)' \
    <<<"$inspect" >/dev/null
  jq -e --arg host "$host" --arg project_id "project-$project" \
    '.[0].Config.Labels["dim.host"] == $host
      and .[0].Config.Labels["dim.project-id"] == $project_id
      and .[0].Config.Labels["dim.resource"] == "ci-ordinary-job"' <<<"$inspect" >/dev/null
  printf 'ordinary-ci-pool-runner host=%s organization=%s runtime=sysbox-runc cpus=1.25 memory=768m pids=256 privileged=false docker_socket=absent kvm_device=absent\n' \
    "$host" "$organization"
  docker logs --follow "$container_id" >"$work_dir/runner-$host.log" 2>&1 &
  runner_logs_pid=$!
  if ! wait "$worker_pid"; then
    worker_pid=""
    printf 'ordinary CI worker failed for host=%s organization=%s\n' "$host" "$organization" >&2
    while IFS= read -r worker_log_line; do
      printf '%s\n' "$worker_log_line" >&2
    done <"$worker_log"
    return 1
  fi
  worker_pid=""
  kill "$runner_logs_pid" >/dev/null 2>&1 || true
  wait "$runner_logs_pid" >/dev/null 2>&1 || true
  runner_logs_pid=""
  if ! jq -e --arg project_id "project-$project" --argjson job_id "$queued_id" \
    '.status == "completed" and .claim.projectId == $project_id and .claim.jobId == $job_id' "$worker_log" >/dev/null; then
    printf 'invalid worker completion for host=%s organization=%s; worker output follows\n' "$host" "$organization" >&2
    while IFS= read -r worker_log_line; do
      printf '%s\n' "$worker_log_line" >&2
    done <"$worker_log"
    return 1
  fi
  created_runner_image_id="$(docker image inspect "$runner_tag" --format '{{.Id}}' 2>/dev/null || printf '%s' "$runner_image_before")"
  cache_after="$(docker logs "$registry_cache" 2>&1 | grep -c '/v2/library/ubuntu/' || true)"
  [[ "$cache_after" -gt "$cache_before" ]] || {
    printf 'runner %s did not route the job image through %s\n' "$host" "$registry_cache" >&2
    return 1
  }
  assert_no_local_projects "$host"
  run_result="$(gitea_api GET "/repos/$organization/app/actions/runs?limit=20")"
  if ! jq -e '.workflow_runs | any(.status == "completed" and .conclusion == "success")' <<<"$run_result" >/dev/null; then
    printf 'Gitea workflow failed for host=%s organization=%s; recent run statuses follow\n' "$host" "$organization" >&2
    jq -r '.workflow_runs[] | "run=\(.id) status=\(.status) conclusion=\(.conclusion // "none")"' <<<"$run_result" >&2
    if [[ -s "$work_dir/runner-$host.log" ]]; then
      tail -n 60 "$work_dir/runner-$host.log" >&2
    fi
    return 1
  fi
  run_id="$(jq -er '[.workflow_runs[] | select(.status == "completed" and .conclusion == "success")][0].id' <<<"$run_result")"
  printf 'ordinary-ci-pool-workflow host=%s organization=%s hook_id=%s webhook_job_id=%s run_id=%s conclusion=success cache_ingress_delta=%s local_project_records=0\n' \
    "$host" "$organization" "$hook_id" "$queued_id" "$run_id" "$((cache_after - cache_before))"
}

printf '%s\n' 'ordinary-ci-pool: queue alpha and dispatch it to logical host-b'
create_workflow dim-alpha alpha-on-host-b
alpha_job_id="$(wait_for_webhook_queue project-alpha)"
run_worker host-b alpha dim-alpha "$alpha_hook_id" "$alpha_job_id"

printf '%s\n' 'ordinary-ci-pool: queue beta and dispatch it to logical host-a'
create_workflow dim-beta beta-on-host-a
beta_job_id="$(wait_for_webhook_queue project-beta)"
run_worker host-a beta dim-beta "$beta_hook_id" "$beta_job_id"

current_cache_id="$(resource_id container "$registry_cache")"
[[ -n "$current_cache_id" ]]
[[ -z "$cache_id_before" || "$current_cache_id" == "$cache_id_before" ]]
printf '%s\n' 'ordinary-ci-pool-topology=two logical host identities on one guest; physical-two-host evidence remains separate'
printf '%s\n' ordinary-ci-pool-live-smoke-ok
