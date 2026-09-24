#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-packaged-shared-scheduler.XXXXXX)"
suffix="$(basename "$work_dir" | tr '[:upper:]' '[:lower:]')"
network="dim-shared-scheduler-$suffix"
state_volume="dim-shared-scheduler-state-$suffix"
evidence_volume="dim-shared-scheduler-evidence-$suffix"
scheduler_container="dim-shared-scheduler-$suffix"
init_container="dim-shared-scheduler-init-$suffix"
worker_a="dim-shared-worker-a-$suffix"
worker_b="dim-shared-worker-b-$suffix"
scheduler_image="dim-shared-qemu-scheduler-smoke:$suffix"
worker_image="dim-shared-qemu-worker-smoke:$suffix"
umask 077

cleanup() {
  docker container rm --force "$worker_a" "$worker_b" "$scheduler_container" "$init_container" >/dev/null 2>&1 || true
  docker image rm --force "$worker_image" "$scheduler_image" >/dev/null 2>&1 || true
  docker volume rm --force "$state_volume" "$evidence_volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

for command in docker node; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 2; }
done
docker info >/dev/null

docker build --tag "$scheduler_image" "$root_dir/core/packages/core/dist/shared-qemu-scheduler-assets" >/dev/null
node --input-type=module - "$work_dir/worker.py" "$root_dir/core/packages/core/dist/qemuCiRunnerWebhookAsset.js" <<'EOF'
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [output, modulePath] = process.argv.slice(2);
const { QEMU_CI_WEBHOOK_SCRIPT } = await import(pathToFileURL(modulePath).href);
await writeFile(output, QEMU_CI_WEBHOOK_SCRIPT, { mode: 0o555 });
EOF
cat >"$work_dir/supervise.bash" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
env | sort >"/evidence/environment-$DIM_QEMU_CI_CAPACITY"
[[ -z "${DIM_QEMU_SCHEDULER_TOKEN:-}" ]]
[[ -z "${DIM_QEMU_WEBHOOK_AUTHORIZATION:-}" ]]
touch "/evidence/started-$DIM_QEMU_CI_CAPACITY"
trap 'touch "/evidence/terminated-$DIM_QEMU_CI_CAPACITY"; exit 0' TERM
while [[ ! -f "/evidence/finish-$DIM_QEMU_CI_CAPACITY" ]]; do sleep 0.05; done
EOF
chmod 0555 "$work_dir/supervise.bash"
cat >"$work_dir/sitecustomize.py" <<'EOF'
import os
import time
_real_monotonic = time.monotonic
def _fixture_monotonic():
    return _real_monotonic() + (120 if os.path.exists("/tmp/advance-clock") else 0)
time.monotonic = _fixture_monotonic
EOF
cat >"$work_dir/http-status.py" <<'EOF'
import sys
import urllib.error
import urllib.request
url, authorization, host_id, event, body = sys.argv[1:]
headers = {"Authorization": authorization}
if host_id:
    headers["X-DIM-Host"] = host_id
if event:
    headers["X-Gitea-Event"] = event
data = None
if body:
    headers["Content-Type"] = "application/json"
    data = body.encode("utf-8")
request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
try:
    with urllib.request.urlopen(request, timeout=2) as response:
        print(response.status)
except urllib.error.HTTPError as error:
    print(error.code)
EOF
cat >"$work_dir/worker.Dockerfile" <<'EOF'
FROM python:3.13.7-slim@sha256:5f55cdf0c5d9dc1a415637a5ccc4a9e18663ad203673173b8cda8f8dcacef689
COPY worker.py /usr/local/bin/dim-qemu-ci-worker
COPY supervise.bash /usr/local/bin/dim-qemu-ci-supervise
COPY sitecustomize.py /usr/local/lib/python3.13/site-packages/sitecustomize.py
COPY http-status.py /usr/local/bin/http-status.py
RUN chmod 0555 /usr/local/bin/dim-qemu-ci-worker /usr/local/bin/dim-qemu-ci-supervise /usr/local/lib/python3.13/site-packages/sitecustomize.py /usr/local/bin/http-status.py
ENTRYPOINT ["python3", "/usr/local/bin/dim-qemu-ci-worker"]
EOF
docker build --tag "$worker_image" --file "$work_dir/worker.Dockerfile" "$work_dir" >/dev/null

cat >"$work_dir/config.json" <<'EOF'
{"schemaVersion":1,"listen":{"host":"0.0.0.0","port":8080},"database":"/var/lib/dim-scheduler/scheduler.sqlite3","leaseSeconds":60,"projects":{"shared-project":{"webhookToken":"webhook-secret","apiToken":"project-api-secret","labels":["dim-qemu"]}}}
EOF
chmod 0600 "$work_dir/config.json"
docker network create --label dim.verification=packaged-shared-scheduler "$network" >/dev/null
docker volume create --label dim.verification=packaged-shared-scheduler "$state_volume" >/dev/null
docker volume create --label dim.verification=packaged-shared-scheduler "$evidence_volume" >/dev/null
docker create --name "$init_container" --user 0 --entrypoint sleep \
  --mount "type=volume,source=$state_volume,target=/var/lib/dim-scheduler" "$scheduler_image" 30 >/dev/null
docker start "$init_container" >/dev/null
docker cp "$work_dir/config.json" "$init_container:/var/lib/dim-scheduler/config.json"
docker exec "$init_container" chown 10001:10001 /var/lib/dim-scheduler/config.json
docker exec "$init_container" chmod 0600 /var/lib/dim-scheduler/config.json
docker rm --force "$init_container" >/dev/null

start_worker() {
  local container="$1" host_id="$2" capacity="$3" authorization="$4"
  docker run --detach --name "$container" --network "$network" \
    --mount "type=volume,source=$evidence_volume,target=/evidence" \
    --env "DIM_QEMU_WEBHOOK_AUTHORIZATION=$authorization" \
    --env DIM_QEMU_SCHEDULER_ENDPOINT=http://scheduler:8080 \
    --env DIM_QEMU_SCHEDULER_PROJECT_ID=shared-project \
    --env "DIM_QEMU_SCHEDULER_HOST_ID=$host_id" \
    --env DIM_QEMU_SCHEDULER_TOKEN=project-api-secret \
    --env "DIM_QEMU_CI_CAPACITY=$capacity" \
    --env DIM_QEMU_CI_LABELS=dim-qemu \
    --env DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS=0.2 \
    "$worker_image" >/dev/null
}

wait_http() {
  local container="$1" expected="$2" url="$3" authorization="${4:-}" status
  for attempt in $(seq 1 150); do
    status="$(docker exec "$container" python3 /usr/local/bin/http-status.py "$url" "$authorization" '' '' '' 2>/dev/null || true)"
    [[ "$status" == "$expected" ]] && return
    [[ "$attempt" -lt 150 ]] || { printf 'expected HTTP %s from %s, got %s\n' "$expected" "$url" "$status" >&2; return 1; }
    sleep 0.1
  done
}

start_worker "$worker_a" host-a capacity-a 'Bearer readiness-a'
start_worker "$worker_b" host-b capacity-b 'Bearer readiness-b'
wait_http "$worker_a" 503 http://127.0.0.1:8080/healthz 'Bearer readiness-a' || { docker logs "$worker_a" >&2; exit 1; }
wait_http "$worker_b" 503 http://127.0.0.1:8080/healthz 'Bearer readiness-b' || { docker logs "$worker_b" >&2; exit 1; }
printf '%s\n' 'packaged-shared-scheduler: workers remain unready before scheduler exchange'

docker run --detach --name "$scheduler_container" --network "$network" --network-alias scheduler \
  --mount "type=volume,source=$state_volume,target=/var/lib/dim-scheduler" \
  "$scheduler_image" >/dev/null
wait_http "$worker_b" 200 http://scheduler:8080/healthz || { docker logs "$scheduler_container" >&2; exit 1; }
wait_http "$worker_a" 200 http://127.0.0.1:8080/healthz 'Bearer readiness-a'
wait_http "$worker_b" 200 http://127.0.0.1:8080/healthz 'Bearer readiness-b'
printf '%s\n' 'packaged-shared-scheduler: both host identities became ready after authenticated exchange'

api_post() {
  local path="$1" token="$2" host_id="$3" body="$4"
  docker exec "$worker_b" python3 /usr/local/bin/http-status.py \
    "http://scheduler:8080$path" "Bearer $token" "$host_id" '' "$body"
}
event_status="$(api_post /v1/events project-api-secret host-a '{"projectId":"shared-project","action":"queued","jobId":701,"labels":["dim-qemu"]}')"
[[ "$event_status" == 202 ]]
for attempt in $(seq 1 100); do
  started_count="$(docker exec "$worker_b" sh -c "find /evidence -maxdepth 1 -name 'started-capacity-*' -printf . | wc -c")"
  [[ "$started_count" -eq 1 ]] && break
  [[ "$attempt" -lt 100 ]] || { docker logs "$worker_a" >&2; docker logs "$worker_b" >&2; exit 1; }
  sleep 0.1
done
sleep 0.5
[[ "$(docker exec "$worker_b" sh -c "find /evidence -maxdepth 1 -name 'started-capacity-*' -printf . | wc -c")" -eq 1 ]]
winner_capacity="$(docker exec "$worker_b" sh -c "basename \"\$(find /evidence -maxdepth 1 -name 'started-capacity-*' -print -quit)\"" | sed 's/^started-//')"
winner_container="$worker_a"
[[ "$winner_capacity" == capacity-b ]] && winner_container="$worker_b"
printf 'packaged-shared-scheduler: one trigger claimed by %s\n' "$winner_capacity"

for retry in 1 2; do
  terminal_status="$(docker exec "$worker_b" python3 /usr/local/bin/http-status.py \
    http://scheduler:8080/v1/webhooks/shared-project/workflow-job 'Bearer webhook-secret' '' workflow_job \
    '{"action":"completed","workflow_job":{"id":701,"labels":["dim-qemu"]}}')"
  [[ "$terminal_status" == 202 ]]
done
for attempt in $(seq 1 100); do
  detached="$(docker exec "$scheduler_container" python3 -c 'import sqlite3; row=sqlite3.connect("/var/lib/dim-scheduler/scheduler.sqlite3").execute("SELECT detached FROM claims").fetchone(); print("" if row is None else row[0])')"
  [[ "$detached" == 1 ]] && break
  [[ "$attempt" -lt 100 ]] || exit 1
  sleep 0.1
done
docker exec "$winner_container" touch /tmp/advance-clock
sleep 1
docker exec "$worker_b" test ! -e "/evidence/terminated-$winner_capacity"
[[ "$(docker inspect "$winner_container" --format '{{.State.Running}}')" == true ]]
printf '%s\n' 'packaged-shared-scheduler: detached fake one-job process survived a 120-second monotonic clock advance'

docker stop --time 10 "$worker_a" >/dev/null
[[ "$(docker inspect "$worker_b" --format '{{.State.Running}}')" == true ]]
wait_http "$worker_b" 200 http://127.0.0.1:8080/healthz 'Bearer readiness-b'
retry_after_shutdown="$(docker exec "$worker_b" python3 /usr/local/bin/http-status.py \
  http://scheduler:8080/v1/webhooks/shared-project/workflow-job 'Bearer webhook-secret' '' workflow_job \
  '{"action":"completed","workflow_job":{"id":701,"labels":["dim-qemu"]}}')"
[[ "$retry_after_shutdown" == 202 ]]
printf '%s\n' 'packaged-shared-scheduler: host A shutdown preserved host B and the central webhook'

docker stop --time 10 "$worker_b" "$scheduler_container" >/dev/null
printf '%s\n' 'packaged-shared-scheduler: fake process fixture used no KVM and makes no full-QEMU claim'
cleanup
trap - EXIT
printf '%s\n' packaged-shared-qemu-scheduler-smoke-ok
