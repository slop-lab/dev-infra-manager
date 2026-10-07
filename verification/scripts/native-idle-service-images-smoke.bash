#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-native-idle-images.XXXXXX)"
native_image="dim-native-git-idle-smoke:$$"
ordinary_image="dim-ordinary-ci-idle-smoke:$$"
config_volume="dim-native-idle-config-$$"
native_state_volume="dim-native-idle-state-$$"
ordinary_state_volume="dim-ordinary-idle-state-$$"
wal_container="dim-ordinary-live-wal-$$"
native_service="dim-native-ready-smoke-$$"
ordinary_service="dim-ordinary-ready-smoke-$$"
service_network="dim-ready-smoke-$$"
native_secrets_volume="dim-native-ready-secrets-$$"
ordinary_secrets_volume="dim-ordinary-ready-secrets-$$"

cleanup() {
  docker container rm --force "$wal_container" "$native_service" "$ordinary_service" >/dev/null 2>&1 || true
  docker network rm "$service_network" >/dev/null 2>&1 || true
  docker volume rm --force "$config_volume" "$native_state_volume" "$ordinary_state_volume" \
    "$native_secrets_volume" "$ordinary_secrets_volume" >/dev/null 2>&1 || true
  docker image rm --force "$native_image" "$ordinary_image" >/dev/null 2>&1 || true
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

docker info >/dev/null
[[ "$(docker version --format '{{.Server.Version}}')" == "29.1.3" ]]
cd -- "$repo_root"

pnpm --dir "$repo_root/core/packages/core" run build >/dev/null
pnpm --dir "$repo_root/core/packages/native-git" run build >/dev/null

node --input-type=module - "$work_dir" <<'EOF'
import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
const token = () => randomBytes(32).toString("base64url");
const credentials = {
  query: token(), identity: token(), attemptIssuer: token(), resultReporter: token(),
  webhook: token(), registrar: token(), host: token()
};
const native = {
  schemaVersion: 2,
  serviceId: "native-main",
  host: "0.0.0.0",
  port: 8080,
  storageRoot: "/var/lib/dim-native-git",
  gitExecutable: "/usr/bin/git",
  gitVersion: "2.43.0",
  repositories: [],
  identities: [],
  ordinaryCi: {
    endpoint: "http://ordinary-ci:8080",
    serviceId: "ordinary-main",
    query: { username: "native-query", password: credentials.query },
    identity: { username: "ordinary-identity", password: credentials.identity },
    attemptIssuer: { username: "ordinary-attempts", password: credentials.attemptIssuer },
    resultReporter: { username: "ordinary-results", password: credentials.resultReporter },
    webhook: {
      endpoint: "http://ordinary-ci:8080/v1/native-events",
      username: "native-events",
      password: credentials.webhook
    }
  }
};
const ordinary = {
  schemaVersion: 3,
  serviceId: "ordinary-main",
  database: "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3",
  admissionLeaseMilliseconds: 300000,
  claimLeaseMilliseconds: 60000,
  nativeGit: {
    endpoint: "http://native-git:8080",
    serviceId: "native-main",
    identity: { username: "ordinary-identity", password: credentials.identity },
    attemptIssuer: { username: "ordinary-attempts", password: credentials.attemptIssuer },
    resultReporter: { username: "ordinary-results", password: credentials.resultReporter }
  },
  credentials: {
    webhook: { username: "native-events", password: credentials.webhook },
    registrar: { username: "ordinary-registrar", password: credentials.registrar },
    query: { username: "native-query", password: credentials.query }
  },
  hosts: [{
    hostId: "host-a",
    hostToken: credentials.host,
    capacities: [{
      capacity: "primary",
      runnerBaseImage: `registry.example/runner@sha256:${"c".repeat(64)}`,
      bounds: {
        cpu: "4", memoryBytes: "8589934592", pids: "2048",
        wallClockSeconds: "3600", outputBytes: "16777216"
      }
    }]
  }]
};

for (const [name, value] of [["native.json", native], ["ordinary.json", ordinary], ["invalid.json", {}]]) {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o444 });
  await chmod(path, 0o444);
}
for (const [name, value] of [
  ["native-readiness.token", token()], ["native-activation.token", token()],
  ["ordinary-readiness.token", token()], ["ordinary-activation.token", token()]
]) {
  const path = join(root, name);
  await writeFile(path, `${value}\n`, { mode: 0o444 });
  await chmod(path, 0o444);
}
EOF

DOCKER_BUILDKIT=0 docker build --quiet --tag "$native_image" \
  --file "$repo_root/core/images/native-git/Dockerfile" "$repo_root" >/dev/null
DOCKER_BUILDKIT=0 docker build --quiet --tag "$ordinary_image" \
  --file "$repo_root/core/images/ordinary-ci/Dockerfile" "$repo_root" >/dev/null

native_id="$(docker image inspect "$native_image" --format '{{.Id}}')"
ordinary_id="$(docker image inspect "$ordinary_image" --format '{{.Id}}')"
base_id="sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df"
for image in "$native_image" "$ordinary_image"; do
  [[ "$(docker image inspect "$image" --format '{{.Architecture}}')" == "amd64" ]]
  [[ "$(docker image inspect "$image" --format '{{json .Config.Entrypoint}}')" == '["/usr/local/bin/dim-service"]' ]]
  docker history --no-trunc --format '{{.ID}}' "$image" | grep -Fx "$base_id" >/dev/null
done
[[ "$(docker image inspect "$native_image" --format '{{.Config.User}}')" == "10001:10001" ]]
[[ "$(docker image inspect "$ordinary_image" --format '{{.Config.User}}')" == "10002:10002" ]]

docker volume create "$config_volume" >/dev/null
docker volume create "$native_state_volume" >/dev/null
docker volume create "$ordinary_state_volume" >/dev/null
for fixture in native ordinary invalid; do
  docker run --rm --interactive --user 0:0 --entrypoint sh \
    --mount "type=volume,src=$config_volume,dst=/fixtures" "$ordinary_image" \
    -ec "cat > /fixtures/$fixture.json && chmod 0444 /fixtures/$fixture.json" <"$work_dir/$fixture.json"
done

common=(--rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges)
[[ "$(docker run "${common[@]}" --user 10001:10001 --entrypoint node "$native_image" --version)" == "v24.19.0" ]]
[[ "$(docker run "${common[@]}" --user 10002:10002 --entrypoint node "$ordinary_image" --version)" == "v24.19.0" ]]
expected='{"schemaVersion":1,"writeFormat":3,"readableFormats":[3]}'
[[ "$(docker run "${common[@]}" --user 10001:10001 "$native_image" compatibility --json)" == "$expected" ]]
[[ "$(docker run "${common[@]}" --user 10002:10002 "$ordinary_image" compatibility --json)" == "$expected" ]]

config_mount="type=volume,src=$config_volume,dst=/run/fixtures,readonly"
docker run "${common[@]}" --user 10001:10001 --mount "$config_mount" \
  "$native_image" check-config /run/fixtures/native.json
docker run "${common[@]}" --user 10002:10002 --mount "$config_mount" \
  "$ordinary_image" check-config /run/fixtures/ordinary.json
docker run "${common[@]}" --user 10001:10001 --mount "$config_mount" \
  "$native_image" check-bundle-config /run/fixtures/native.json /run/fixtures/ordinary.json
if docker run "${common[@]}" --user 10001:10001 --mount "$config_mount" \
  "$native_image" check-config /run/fixtures/invalid.json >"$work_dir/invalid-native.out" 2>&1; then
  echo "native invalid configuration unexpectedly passed" >&2
  exit 1
fi
if docker run "${common[@]}" --user 10002:10002 --mount "$config_mount" \
  "$ordinary_image" check-config /run/fixtures/invalid.json >"$work_dir/invalid-ordinary.out" 2>&1; then
  echo "ordinary invalid configuration unexpectedly passed" >&2
  exit 1
fi
grep -F "invalid native Git bundle configuration" "$work_dir/invalid-native.out" >/dev/null
grep -F "invalid ordinary CI bundle configuration" "$work_dir/invalid-ordinary.out" >/dev/null

docker run "${common[@]}" --user 10001:10001 --entrypoint node \
  --mount "type=volume,src=$native_state_volume,dst=/var/lib/dim-native-git" "$native_image" \
  --input-type=module -e 'import { initializeNativeGitBundleState } from "/usr/local/lib/dim/native-bundle-state.js";
    const state = await initializeNativeGitBundleState("/var/lib/dim-native-git"); await state.owner.release();'
docker run --detach --name "$wal_container" --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges --user 10002:10002 --entrypoint node \
  --mount "type=volume,src=$ordinary_state_volume,dst=/var/lib/dim-ordinary-ci" "$ordinary_image" \
  --input-type=module -e 'import { DatabaseSync } from "node:sqlite";
    import { initializeNativeOrdinaryBundleState } from "/usr/local/lib/dim/nativeOrdinaryBundleState.js";
    const state = await initializeNativeOrdinaryBundleState("/var/lib/dim-ordinary-ci");
    const database = new DatabaseSync(state.database); database.exec("PRAGMA journal_mode = WAL");
    database.prepare("INSERT INTO bundle_activation VALUES (?, ?)").run("a".repeat(64), "b".repeat(64));
    console.log("live-wal-ready"); process.on("SIGTERM", () => { database.close(); process.exit(0); });
    await new Promise(() => {});' >/dev/null
for _ in {1..100}; do docker logs "$wal_container" 2>&1 | grep -Fx "live-wal-ready" >/dev/null && break; sleep 0.05; done
docker logs "$wal_container" 2>&1 | grep -Fx "live-wal-ready" >/dev/null

state_digest() {
  local image="$1" volume="$2"
  docker run --rm --network none --user 0:0 --entrypoint tar \
    --mount "type=volume,src=$volume,dst=/state,readonly" "$image" -C /state -cf - . | sha256sum
}
native_before="$(state_digest "$native_image" "$native_state_volume")"
ordinary_before="$(state_digest "$ordinary_image" "$ordinary_state_volume")"
native_state_mount="type=volume,src=$native_state_volume,dst=/var/lib/dim-native-git,readonly"
ordinary_state_mount="type=volume,src=$ordinary_state_volume,dst=/var/lib/dim-ordinary-ci,readonly"
[[ "$(docker run "${common[@]}" --user 10001:10001 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --mount "$native_state_mount" "$native_image" check-state --read-only /var/lib/dim-native-git --json)" == \
  '{"schemaVersion":1,"stateFormat":3}' ]]
[[ "$(docker run "${common[@]}" --user 10002:10002 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --mount "$ordinary_state_mount" "$ordinary_image" check-state --read-only /var/lib/dim-ordinary-ci --json)" == \
  '{"schemaVersion":1,"stateFormat":3}' ]]
[[ "$(state_digest "$native_image" "$native_state_volume")" == "$native_before" ]]
[[ "$(state_digest "$ordinary_image" "$ordinary_state_volume")" == "$ordinary_before" ]]

docker container rm --force "$wal_container" >/dev/null
docker volume create "$native_secrets_volume" >/dev/null
docker volume create "$ordinary_secrets_volume" >/dev/null
copy_secrets() {
  local service="$1" volume="$2" image="$3"
  tar -C "$work_dir" -cf - "$service.json" "$service-readiness.token" "$service-activation.token" | \
    docker run --rm --interactive --user 0:0 --entrypoint sh \
      --mount "type=volume,src=$volume,dst=/run/secrets" "$image" -ec \
      "tar -C /run/secrets -xf - && mv /run/secrets/$service.json /run/secrets/service.json && \
       mv /run/secrets/$service-readiness.token /run/secrets/readiness.token && \
       mv /run/secrets/$service-activation.token /run/secrets/activation.token && chmod 0444 /run/secrets/*"
}
copy_secrets native "$native_secrets_volume" "$native_image"
copy_secrets ordinary "$ordinary_secrets_volume" "$ordinary_image"
docker network create "$service_network" >/dev/null
ordinary_generation="$(printf ordinary-ready-smoke | sha256sum | cut -d ' ' -f 1)"
native_generation="$(printf native-ready-smoke | sha256sum | cut -d ' ' -f 1)"
docker run --detach --name "$ordinary_service" --network "$service_network" --network-alias ordinary-ci \
  --publish 127.0.0.1::8080 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 \
  --mount "type=volume,src=$ordinary_secrets_volume,dst=/run/secrets,readonly" \
  --mount "type=volume,src=$ordinary_state_volume,dst=/var/lib/dim-ordinary-ci" \
  "$ordinary_image" serve /run/secrets/service.json "$ordinary_generation" >/dev/null
for _ in {1..100}; do
  docker container exec --user 10002:10002 "$ordinary_service" /usr/local/bin/dim-service ready \
    >"$work_dir/ordinary-ready.out" 2>"$work_dir/ordinary-ready.err" && break
  sleep 0.05
done
[[ ! -s "$work_dir/ordinary-ready.out" && ! -s "$work_dir/ordinary-ready.err" ]]
docker run --detach --name "$native_service" --network "$service_network" --network-alias native-git \
  --publish 127.0.0.1::8080 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 \
  --mount "type=volume,src=$native_secrets_volume,dst=/run/secrets,readonly" \
  --mount "type=volume,src=$native_state_volume,dst=/var/lib/dim-native-git" \
  "$native_image" serve /run/secrets/service.json "$native_generation" >/dev/null
for _ in {1..100}; do
  docker container exec --user 10001:10001 "$native_service" /usr/local/bin/dim-service ready \
    >"$work_dir/native-ready.out" 2>"$work_dir/native-ready.err" && break
  sleep 0.05
done
[[ ! -s "$work_dir/native-ready.out" && ! -s "$work_dir/native-ready.err" ]]
mapfile -t raw_network_members < <(docker network inspect "$service_network" --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' | sort)
network_members=()
for member in "${raw_network_members[@]}"; do
  [[ -z "$member" ]] || network_members+=("$member")
done
[[ "${network_members[*]}" == "$native_service $ordinary_service" ]]
published_port="$(docker container port "$ordinary_service" 8080/tcp | cut -d: -f2)"
set +e
curl --fail --silent --max-time 1 "http://127.0.0.1:$published_port/readyz" >/dev/null 2>&1
curl_status=$?
set -e
[[ "$curl_status" -eq 22 ]]

docker run "${common[@]}" --user 10001:10001 --entrypoint sh "$native_image" -ec '
  test ! -e /run/secrets/service.json
  test ! -S /var/run/docker.sock
  test "$(id -u):$(id -g)" = 10001:10001
  grep -q "^NoNewPrivs:[[:space:]]*1$" /proc/self/status
  grep -q "^CapEff:[[:space:]]*0000000000000000$" /proc/self/status
  test "$(printf "%s\n" /usr/local/lib/dim/node_modules/* | sed "s!.*/!!" | sort | tr "\n" " ")" = "yaml zod "
'
docker run "${common[@]}" --user 10002:10002 --entrypoint sh "$ordinary_image" -ec '
  test ! -e /run/secrets/service.json
  test ! -S /var/run/docker.sock
  test ! -d /usr/local/lib/dim/node_modules
  test "$(id -u):$(id -g)" = 10002:10002
  grep -q "^NoNewPrivs:[[:space:]]*1$" /proc/self/status
  grep -q "^CapEff:[[:space:]]*0000000000000000$" /proc/self/status
'

printf 'native-idle-service-images-smoke-ok base=%s native=%s ordinary=%s\n' \
  "$base_id" "$native_id" "$ordinary_id"
