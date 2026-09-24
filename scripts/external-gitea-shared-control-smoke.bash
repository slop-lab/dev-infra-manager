#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
gitea_image="gitea/gitea@sha256:7dff60d7ea6df9d0bdf78971cdb1350e9b7df3fda5f115c77afe12122887bd64"
work_dir="$(mktemp -d /tmp/dim-external-gitea-shared.XXXXXX)"
suffix="$(basename "$work_dir")"
network="dim-external-gitea-$suffix"
gitea_container="dim-external-gitea-$suffix"
controller_a_pid=""
controller_b_pid=""
malicious_pid=""
existing_dim_gitea="$(docker container inspect dim-gitea --format '{{.Id}}|{{.State.Running}}|{{.State.StartedAt}}|{{.RestartCount}}' 2>/dev/null || true)"
umask 077

cleanup() {
  local pid
  for pid in "$controller_a_pid" "$controller_b_pid" "$malicious_pid"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
  docker container rm --force "$gitea_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

for command in curl docker git jq node openssl; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 2; }
done
docker info >/dev/null
printf '%s\n' 'external-gitea: starting disposable service'

admin_password="$(openssl rand -hex 24)"
writer_password="$(openssl rand -hex 24)"
wrong_password="$(openssl rand -hex 24)"

docker network create --label dim.verification=external-gitea "$network" >/dev/null
docker run --detach --name "$gitea_container" \
  --label dim.verification=external-gitea \
  --publish 127.0.0.1::3000 \
  --env GITEA__database__DB_TYPE=sqlite3 \
  --env GITEA__security__INSTALL_LOCK=true \
  --env GITEA__server__DISABLE_SSH=true \
  --env GITEA__service__DISABLE_REGISTRATION=true \
  "$gitea_image" >/dev/null
docker network connect --alias external-gitea --alias external-gitea-runner "$network" "$gitea_container"
gitea_port="$(docker port "$gitea_container" 3000/tcp \
  | jq -Rrs 'split("\n") | map(select(length > 0)) | last | split(":") | last')"
[[ "$gitea_port" =~ ^[0-9]+$ ]]
gitea_address="$(docker container inspect "$gitea_container" \
  --format '{{with index .NetworkSettings.Networks "bridge"}}{{.IPAddress}}{{end}}')"
[[ -n "$gitea_address" ]]
gitea_url="http://$gitea_address:3000"
gitea_host_url="$gitea_url"
for attempt in $(seq 1 90); do
  if curl --fail --silent "$gitea_url/api/healthz" >/dev/null 2>&1; then
    break
  fi
  [[ "$attempt" -lt 90 ]] || { docker logs "$gitea_container" >&2; exit 1; }
  sleep 1
done

docker exec --user git "$gitea_container" gitea admin user create \
  --username dim-operator --password "$admin_password" --email operator@dim.invalid \
  --admin --must-change-password=false >/dev/null
docker exec --user git "$gitea_container" gitea admin user create \
  --username dim-workspace --password "$writer_password" --email workspace@dim.invalid \
  --must-change-password=false >/dev/null
organization_response="$work_dir/organization.json"
curl --fail --silent --show-error --user "dim-operator:$admin_password" \
  --header 'content-type: application/json' --request POST \
  --data '{"username":"dim-shared","full_name":"dim-shared","visibility":"private"}' \
  --output "$organization_response" "$gitea_url/api/v1/orgs"
organization_id="$(jq -er '.id | select(type == "number" and . > 0)' "$organization_response")"
printf '%s\n' 'external-gitea: provisioned fixture identities'

mkdir -p "$work_dir/fake-bin"
cat >"$work_dir/fake-bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$DIM_DOCKER_INVOCATIONS"
if [[ "$1 $2" == "container ls" ]]; then
  exit 0
fi
if [[ "$1 $2 $3" == "container inspect dim-registry-cache" ]]; then
  printf 'Error: No such container: dim-registry-cache\n' >&2
  exit 1
fi
printf 'controller Docker operation denied: %s\n' "$1" >&2
exit 97
EOF
chmod 0700 "$work_dir/fake-bin/docker"
cat >"$work_dir/fake-bin/dim" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec node --import "$DIM_SOURCE_ROOT/core-development/node_modules/tsx/dist/loader.mjs" \
  "$DIM_SOURCE_ROOT/core/packages/cli/src/cli.ts" "$@"
EOF
chmod 0700 "$work_dir/fake-bin/dim"
: >"$work_dir/docker-invocations"

write_connection() {
  local destination="$1" password="$2" host_id="$3"
  jq -n \
    --arg api "$gitea_url/api/v1" --arg host "$gitea_host_url" \
    --arg workspace "http://external-gitea:3000" --arg runner "http://external-gitea-runner:3000" \
    --arg host_id "$host_id" \
    --arg admin "$password" --arg writer "$writer_password" --arg maintainer "$password" \
    --argjson organization "$organization_id" \
    '{schemaVersion:1,transport:"isolated-http",hostId:$host_id,apiBaseUrl:$api,hostBaseUrl:$host,workspaceBaseUrl:$workspace,runnerBaseUrl:$runner,credentials:{adminUsername:"dim-operator",adminPassword:$admin,writerUsername:"dim-workspace",writerPassword:$writer,maintainerUsername:"dim-operator",maintainerPassword:$maintainer},projects:{shared:{id:"shared-project-id",gitNamespace:"dim-shared",giteaOrganizationId:$organization}}}' \
    >"$destination"
  chmod 0600 "$destination"
}

start_controller() {
  local client="$1" connection="$2" client_root
  client_root="$work_dir/$client"
  mkdir -p "$client_root/config/dim" "$client_root/plugins" "$client_root/runtime"
  printf '%s\n' '{"schemaVersion":1,"workspaceBackend":"sysbox"}' >"$client_root/config/dim/config.json"
  env \
    PATH="$work_dir/fake-bin:$PATH" \
    DIM_DOCKER_INVOCATIONS="$work_dir/docker-invocations" \
    DIM_STATE_ROOT="$client_root/state" \
    DIM_GITEA_CONNECTION_FILE="$connection" \
    DIM_PLUGIN_HOME="$client_root/plugins" \
    XDG_CONFIG_HOME="$client_root/config" \
    node --import "$root_dir/core-development/node_modules/tsx/dist/loader.mjs" \
      "$root_dir/core/packages/cli/src/cli.ts" controller serve \
      --socket "$client_root/runtime/workspace.sock" \
      --admin-socket "$client_root/runtime/admin.sock" \
      --agent-socket "$client_root/runtime/agent.sock" \
      --pid-file "$client_root/runtime/controller.pid" \
      >"$client_root/runtime/controller.log" 2>&1 &
  local pid=$!
  for attempt in $(seq 1 60); do
    if [[ -S "$client_root/runtime/admin.sock" ]]; then
      started_controller_pid="$pid"
      return
    fi
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      cat "$client_root/runtime/controller.log" >&2
      return 1
    fi
    [[ "$attempt" -lt 60 ]] || { cat "$client_root/runtime/controller.log" >&2; return 1; }
    sleep 1
  done
}

admin_call() {
  local client="$1" operation="$2" body="$3" output="$4"
  curl --fail --silent --show-error --unix-socket "$work_dir/$client/runtime/admin.sock" \
    --header 'content-type: application/json' --request POST --data "$body" \
    --output "$output" "http://localhost/v1/call/$operation"
}

connection_a="$work_dir/client-a-connection.json"
connection_b="$work_dir/client-b-connection.json"
write_connection "$connection_a" "$wrong_password" host-a
write_connection "$connection_b" "$admin_password" host-b
started_controller_pid=""
start_controller client-a "$connection_a"
controller_a_pid="$started_controller_pid"
start_controller client-b "$connection_b"
controller_b_pid="$started_controller_pid"
printf '%s\n' 'external-gitea: started two isolated controllers'
[[ "$work_dir/client-a/state" != "$work_dir/client-b/state" ]]
[[ "$work_dir/client-a/runtime/admin.sock" != "$work_dir/client-b/runtime/admin.sock" ]]
[[ "$(stat -c '%i' "$work_dir/client-a/runtime/admin.sock")" != \
  "$(stat -c '%i' "$work_dir/client-b/runtime/admin.sock")" ]]

failure_body="$work_dir/bad-credential.json"
failure_status="$(curl --silent --unix-socket "$work_dir/client-a/runtime/admin.sock" \
  --header 'content-type: application/json' --request POST --data '{}' \
  --output "$failure_body" --write-out '%{http_code}' \
  http://localhost/v1/call/service.ensure)"
if [[ "$failure_status" != 400 ]]; then
  printf 'invalid credential returned HTTP %s: %s\n' \
    "$failure_status" "$(jq -r '.error // "missing error"' "$failure_body")" >&2
  exit 1
fi
if ! jq -er '.error | test("External Gitea (health check failed: 401|authenticate)")' "$failure_body" >/dev/null; then
  printf 'invalid credential error was: %s\n' "$(jq -r '.error // "missing error"' "$failure_body")" >&2
  exit 1
fi
write_connection "$connection_a" "$admin_password" host-a
printf '%s\n' 'external-gitea: rejected invalid credential'

service_a="$work_dir/service-a.json"
service_b="$work_dir/service-b.json"
admin_call client-a service.ensure '{}' "$service_a"
admin_call client-b service.ensure '{}' "$service_b"
jq -e --arg endpoint "$gitea_host_url" '.kind == "external" and .hostId == "host-a" and .hostBaseUrl == $endpoint' "$service_a" >/dev/null
jq -e --arg endpoint "$gitea_host_url" '.kind == "external" and .hostId == "host-b" and .hostBaseUrl == $endpoint' "$service_b" >/dev/null
printf '%s\n' 'external-gitea: validated endpoint roles'

admin_call client-a project.create '{"name":"shared"}' "$work_dir/project-a.json"
admin_call client-b project.create '{"name":"shared"}' "$work_dir/project-b.json"
admin_call client-a repo.prepare \
  '{"project":"shared","alias":"root","root":true,"ref":"main","protectedPatterns":[],"forcePushBlockedPatterns":[]}' \
  "$work_dir/repo-a.json"
admin_call client-b repo.prepare \
  '{"project":"shared","alias":"root","root":true,"ref":"main","protectedPatterns":[],"forcePushBlockedPatterns":[]}' \
  "$work_dir/repo-b.json"
admin_call client-a repo.prepare \
  '{"project":"shared","alias":"extra","root":false,"protectedPatterns":[],"forcePushBlockedPatterns":[]}' \
  "$work_dir/extra-a.json"
admin_call client-b repo.prepare \
  '{"project":"shared","alias":"extra","root":false,"protectedPatterns":[],"forcePushBlockedPatterns":[]}' \
  "$work_dir/extra-b.json"
printf '%s\n' 'external-gitea: attached both clients to one Project repository'

host_url="$gitea_host_url/dim-shared/root.git"
jq -e --arg id shared-project-id --argjson organization "$organization_id" \
  '.id == $id and .giteaOrganizationId == $organization' "$work_dir/project-a.json" >/dev/null
jq -e --arg id shared-project-id --argjson organization "$organization_id" \
  '.id == $id and .giteaOrganizationId == $organization' "$work_dir/project-b.json" >/dev/null
[[ -f "$work_dir/client-a/state/projects/shared.json" ]]
[[ -f "$work_dir/client-b/state/projects/shared.json" ]]
[[ "$(realpath "$work_dir/client-a/state")" != "$(realpath "$work_dir/client-b/state")" ]]
for response in "$work_dir/repo-a.json" "$work_dir/repo-b.json"; do
  jq -e --arg host_url "$host_url" --arg workspace_url "http://external-gitea:3000/dim-shared/root.git" \
    '.repository.hostUrl == $host_url and .repository.workspaceUrl == $workspace_url' "$response" >/dev/null
done
curl --fail --silent --show-error --user "dim-operator:$admin_password" \
  --header 'content-type: application/json' --request PATCH --data '{"private":true}' \
  --output "$work_dir/private-repository.json" "$gitea_url/api/v1/repos/dim-shared/root"
jq -e '.private == true' "$work_dir/private-repository.json" >/dev/null

source_repo="$work_dir/source"
git init --quiet --initial-branch=main "$source_repo"
git -C "$source_repo" config user.name 'Shared control verification'
git -C "$source_repo" config user.email shared-control@dim.invalid
printf '%s\n' shared-external-gitea >"$source_repo/evidence.txt"
git -C "$source_repo" add evidence.txt
git -C "$source_repo" commit --quiet -m 'seed shared repository'
credential_helper='!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f'
if env DIM_GIT_USERNAME=dim-workspace DIM_GIT_TOKEN="$wrong_password" GIT_TERMINAL_PROMPT=0 \
  git -c credential.helper= -c "credential.helper=$credential_helper" \
  clone --quiet "$host_url" "$work_dir/bad-credential-clone" >/dev/null 2>&1; then
  printf 'invalid Git credential cloned the private repository\n' >&2
  exit 1
fi
env DIM_GIT_USERNAME=dim-workspace DIM_GIT_TOKEN="$writer_password" GIT_TERMINAL_PROMPT=0 \
  git -C "$source_repo" -c credential.helper= -c "credential.helper=$credential_helper" \
  push --quiet "$host_url" main

for client in client-a client-b; do
  username=dim-workspace
  password="$writer_password"
  if [[ "$client" == client-b ]]; then
    username=dim-operator
    password="$admin_password"
  fi
  env DIM_GIT_USERNAME="$username" DIM_GIT_TOKEN="$password" GIT_TERMINAL_PROMPT=0 \
    git -c credential.helper= -c "credential.helper=$credential_helper" \
    clone --quiet "$host_url" "$work_dir/$client-clone"
  [[ "$(cat "$work_dir/$client-clone/evidence.txt")" == shared-external-gitea ]]
done
printf '%s\n' 'external-gitea: cloned and read the private remote through both clients'

: >"$work_dir/malicious-headers"
env HEADERS_FILE="$work_dir/malicious-headers" PORT_FILE="$work_dir/malicious-port" node -e '
  const fs = require("node:fs");
  const http = require("node:http");
  const server = http.createServer((request, response) => {
    fs.appendFileSync(process.env.HEADERS_FILE, JSON.stringify(request.headers) + "\n");
    response.writeHead(401, { "WWW-Authenticate": "Basic realm=attacker" }).end();
  });
  server.listen(0, "127.0.0.1", () => fs.writeFileSync(process.env.PORT_FILE, String(server.address().port)));
' &
malicious_pid=$!
for attempt in $(seq 1 30); do
  [[ -s "$work_dir/malicious-port" ]] && break
  [[ "$attempt" -lt 30 ]] || exit 1
  sleep 0.1
done
malicious_port="$(cat "$work_dir/malicious-port")"
if env PATH="$work_dir/fake-bin:$PATH" DIM_SOURCE_ROOT="$root_dir" \
  DIM_ADMIN_CONTROLLER_SOCKET="$work_dir/client-a/runtime/admin.sock" \
  node --import "$root_dir/core-development/node_modules/tsx/dist/loader.mjs" \
    "$root_dir/core/packages/cli/src/cli.ts" x git ls-remote "http://127.0.0.1:$malicious_port/steal" \
    >/dev/null 2>&1; then
  printf 'malicious Git remote unexpectedly succeeded\n' >&2
  exit 1
fi
if grep -qi 'authorization' "$work_dir/malicious-headers"; then
  printf 'malicious Git remote received DIM credentials\n' >&2
  exit 1
fi
printf '%s\n' 'external-gitea: x git withheld credentials from an unscoped remote'

admin_call client-a repo.delete '{"project":"shared","alias":"extra"}' "$work_dir/delete-extra-a.json"
extra_status="$(curl --silent --user "dim-operator:$admin_password" --output /dev/null --write-out '%{http_code}' \
  "$gitea_url/api/v1/repos/dim-shared/extra")"
[[ "$extra_status" == 404 ]]
admin_call client-b repo.show '{"project":"shared","alias":"extra"}' "$work_dir/extra-b-after-delete.json"
jq -e '.phase == "ready"' "$work_dir/extra-b-after-delete.json" >/dev/null

admin_call client-a project.purge '{"name":"shared"}' "$work_dir/purge-a.json"
organization_status="$(curl --silent --user "dim-operator:$admin_password" --output /dev/null --write-out '%{http_code}' \
  "$gitea_url/api/v1/orgs/dim-shared")"
[[ "$organization_status" == 404 ]]
admin_call client-b project.show '{"name":"shared"}' "$work_dir/project-b-after-purge.json"
jq -e '.phase == "ready"' "$work_dir/project-b-after-purge.json" >/dev/null
printf '%s\n' 'external-gitea: host-admin deletion removed shared remotes while the second host retained stale local records'

admin_call client-a host.shutdown '{}' "$work_dir/shutdown-a.json"
jq -e '.phase == "stopped"' "$work_dir/shutdown-a.json" >/dev/null
curl --fail --silent "$gitea_url/api/healthz" >/dev/null
admin_call client-b project.show '{"name":"shared"}' "$work_dir/project-b-after-shutdown.json"
jq -e '.phase == "ready"' "$work_dir/project-b-after-shutdown.json" >/dev/null
printf '%s\n' 'external-gitea: preserved the service and independent local state after host shutdown'

if grep -q 'dim-gitea' "$work_dir/docker-invocations"; then
  printf 'controller attempted to access local dim-gitea\n' >&2
  exit 1
fi
[[ "$(wc -l <"$work_dir/docker-invocations")" -eq 2 ]]
grep -qx 'container ls --filter label=dim.managed=true --format {{.Names}}' "$work_dir/docker-invocations"
grep -qx 'container inspect dim-registry-cache --format {{.Id}}|{{index .Config.Labels "dim.managed"}}|{{.State.Running}}' \
  "$work_dir/docker-invocations"
[[ ! -e "$work_dir/client-a/state/gitea.json" ]]
[[ ! -e "$work_dir/client-b/state/gitea.json" ]]

current_dim_gitea="$(docker container inspect dim-gitea --format '{{.Id}}|{{.State.Running}}|{{.State.StartedAt}}|{{.RestartCount}}' 2>/dev/null || true)"
[[ "$current_dim_gitea" == "$existing_dim_gitea" ]]
printf '%s\n' 'external-gitea: confirmed local dim-gitea was untouched'

cleanup
trap - EXIT
printf '%s\n' external-gitea-shared-control-smoke-ok
