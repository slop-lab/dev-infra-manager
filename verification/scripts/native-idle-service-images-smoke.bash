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
  schemaVersion: 7,
  serviceId: "native-main",
  host: "0.0.0.0",
  port: 8080,
  storageRoot: "/var/lib/dim-native-git",
  gitExecutable: "/usr/bin/git",
  gitVersion: "2.39.5",
  repositories: [],
  identities: [],
  projectRegistrars: [],
  projectRootImporters: [],
  projectRootReadIssuers: [],
  workspaceWriteIssuers: [],
  humanReviewers: [],
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
  schemaVersion: 4,
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
      jobBaseImage: `registry.example/job@sha256:${"d".repeat(64)}`,
      bounds: {
        cpu: "4", memoryBytes: "8589934592", pids: "2048",
        wallClockSeconds: "3600", outputBytes: "16777216"
      }
    }]
  }]
};
const active = {
  ...native,
  projectRegistrars: [{ hostId: "host-a", username: "project-registrar-a", password: token() }],
  projectRootImporters: [{ hostId: "host-a", username: "project-root-importer-a", password: token() }],
  projectRootReadIssuers: [{ hostId: "host-a", username: "project-root-read-issuer-a", password: token() }],
  workspaceWriteIssuers: [{ hostId: "host-a", username: "workspace-write-issuer-a", password: token() }],
  humanReviewers: [{ reviewerId: "owner", username: "human-reviewer-owner", password: token() }]
};
const writer = {
  serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root",
  writer: { username: "writer-a", password: token(), workspaceId: "workspace-a" }
};

for (const [name, value] of [
  ["native.json", native], ["native-active.json", active], ["writer.json", writer],
  ["ordinary.json", ordinary], ["invalid.json", {}]
]) {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o444 });
  await chmod(path, 0o444);
}
const askpassPath = join(root, "writer-askpass");
await writeFile(askpassPath, `#!/bin/sh
case "$1" in
  Username*) printf '%s' writer-a ;;
  Password*) node -pe 'JSON.parse(require("node:fs").readFileSync("/run/fixtures/writer.json", "utf8")).writer.password' ;;
  *) exit 1 ;;
esac
`, { mode: 0o555 });
await chmod(askpassPath, 0o555);
for (const [name, value] of [
  ["native-readiness.token", token()], ["native-activation.token", token()],
  ["native-activation-b.token", token()],
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
for fixture in native native-active writer ordinary invalid; do
  docker run --rm --interactive --user 0:0 --entrypoint sh \
    --mount "type=volume,src=$config_volume,dst=/fixtures" "$ordinary_image" \
    -ec "cat > /fixtures/$fixture.json && chmod 0444 /fixtures/$fixture.json" <"$work_dir/$fixture.json"
done
docker run --rm --interactive --user 0:0 --entrypoint sh \
  --mount "type=volume,src=$config_volume,dst=/fixtures" "$ordinary_image" \
  -ec 'cat > /fixtures/writer-askpass && chmod 0555 /fixtures/writer-askpass' <"$work_dir/writer-askpass"
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --user 0:0 --entrypoint sh --mount "type=volume,src=$config_volume,dst=/fixtures" \
  "$native_image" -ec '
  export GIT_CONFIG_NOSYSTEM=1 HOME=/tmp LC_ALL=C
  git init --initial-branch=main /tmp/source >/dev/null
  git -C /tmp/source config user.name DIM
  git -C /tmp/source config user.email bootstrap@example.invalid
  printf "trusted root\n" > /tmp/source/README.md
  git -C /tmp/source add README.md
  git -C /tmp/source commit -m bootstrap >/dev/null
  git -C /tmp/source rev-parse HEAD > /fixtures/root.commit
  git -C /tmp/source rev-parse "HEAD^{tree}" > /fixtures/root.tree
  git -C /tmp/source bundle create /fixtures/root.bundle refs/heads/main
  chmod 0444 /fixtures/root.commit /fixtures/root.tree /fixtures/root.bundle
'

common=(--rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges)
[[ "$(docker run "${common[@]}" --user 10001:10001 --entrypoint node "$native_image" --version)" == "v24.19.0" ]]
[[ "$(docker run "${common[@]}" --user 10001:10001 --entrypoint /usr/bin/git "$native_image" --version)" == "git version 2.39.5" ]]
docker run "${common[@]}" --user 10001:10001 --entrypoint node "$native_image" \
  --input-type=module -e 'await import("/usr/local/lib/dim/native-bundle-server.js")'
[[ "$(docker run "${common[@]}" --user 10002:10002 --entrypoint node "$ordinary_image" --version)" == "v24.19.0" ]]
[[ "$(docker run "${common[@]}" --user 10001:10001 "$native_image" compatibility --json)" == \
  '{"schemaVersion":1,"writeFormat":8,"readableFormats":[8]}' ]]
[[ "$(docker run "${common[@]}" --user 10002:10002 "$ordinary_image" compatibility --json)" == \
  '{"schemaVersion":1,"writeFormat":3,"readableFormats":[3]}' ]]

config_mount="type=volume,src=$config_volume,dst=/run/fixtures,readonly"
docker run "${common[@]}" --user 10001:10001 --mount "$config_mount" \
  "$native_image" check-config /run/fixtures/native.json
docker run "${common[@]}" --user 10002:10002 --mount "$config_mount" \
  "$ordinary_image" check-config /run/fixtures/ordinary.json
docker run "${common[@]}" --user 10001:10001 --mount "$config_mount" \
  "$native_image" check-bundle-config /run/fixtures/native.json /run/fixtures/ordinary.json
docker run "${common[@]}" --user 10001:10001 --mount "$config_mount" \
  "$native_image" check-config /run/fixtures/native-active.json
docker run "${common[@]}" --user 10001:10001 --mount "$config_mount" \
  "$native_image" check-bundle-config /run/fixtures/native-active.json /run/fixtures/ordinary.json
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
  '{"schemaVersion":1,"stateFormat":8}' ]]
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
docker container rm --force "$native_service" >/dev/null
docker run --rm --user 0:0 --entrypoint sh \
  --mount "$config_mount" --mount "type=volume,src=$native_secrets_volume,dst=/run/secrets" \
  "$ordinary_image" -ec 'cp /run/fixtures/native-active.json /run/secrets/service.json && chmod 0444 /run/secrets/service.json'
docker run --detach --name "$native_service" --network "$service_network" --network-alias native-git \
  --publish 127.0.0.1::8080 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 \
  --mount "type=volume,src=$native_secrets_volume,dst=/run/secrets,readonly" \
  --mount "type=volume,src=$native_state_volume,dst=/var/lib/dim-native-git" \
  "$native_image" serve /run/secrets/service.json "$native_generation" >/dev/null
for _ in {1..100}; do
  docker container exec --user 10001:10001 "$native_service" /usr/local/bin/dim-service ready \
    >"$work_dir/native-active-ready.out" 2>"$work_dir/native-active-ready.err" && break
  sleep 0.05
done
[[ ! -s "$work_dir/native-active-ready.out" && ! -s "$work_dir/native-active-ready.err" ]]
docker container exec --user 10001:10001 "$native_service" /usr/local/bin/dim-service activate "$native_generation"
docker run --rm --interactive --read-only --network "$service_network" --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges --entrypoint node --mount "$config_mount" \
  "$native_image" --input-type=module <<'EOF'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const native = JSON.parse(readFileSync("/run/fixtures/native-active.json", "utf8"));
const ordinary = JSON.parse(readFileSync("/run/fixtures/ordinary.json", "utf8"));
const { writer, ...preparation } = JSON.parse(readFileSync("/run/fixtures/writer.json", "utf8"));
const registrar = native.projectRegistrars[0];
const auth = ({ username, password }) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const origin = "http://native-git:8080";
const identity = await fetch(`${origin}/v1/operator-project-registrar-identity`, {
  headers: { authorization: auth(registrar) }
});
assert.equal(identity.status, 200);
assert.deepEqual(await identity.json(), {
  schemaVersion: 1, serviceId: "native-main", role: "operator-project-registrar", hostId: "host-a"
});
const body = {
  schemaVersion: 1,
  generationId: createHash("sha256").update("native-ready-smoke").digest("hex"),
  preparation
};
const endpoint = `${origin}/v1/operator-project-preparations`;
const headers = { authorization: auth(registrar), "content-type": "application/json" };
const denied = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...body, hostId: "host-b" }) });
assert.equal(denied.status, 400);
const wrongRole = await fetch(endpoint, { method: "POST", headers: {
  ...headers, authorization: auth(ordinary.credentials.registrar)
}, body: JSON.stringify(body) });
assert.equal(wrongRole.status, 401);
const obsolete = await fetch(`${origin}/v1/operator-project-registrations`, {
  method: "POST", headers, body: JSON.stringify({ ...body, registration: { ...preparation, writer } })
});
assert.equal(obsolete.status, 404);
const prepared = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
assert.equal(prepared.status, 200);
const response = await prepared.text();
assert.equal(response.includes(writer.password), false);
assert.equal(response.includes(registrar.password), false);
assert.deepEqual(JSON.parse(response).preparation, { ...preparation, state: "root-prepared" });
EOF
docker run --rm --read-only --network "$service_network" --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --entrypoint sh --mount "$config_mount" "$native_image" -ec '
  export GIT_ASKPASS=/run/fixtures/writer-askpass GIT_TERMINAL_PROMPT=0 HOME=/tmp
  if git clone http://native-git:8080/v1/projects/project-a/repositories/root.git /tmp/clone > /tmp/denied.out 2>&1; then exit 1; fi
  git init /tmp/repo
  git -C /tmp/repo config user.name DIM
  git -C /tmp/repo config user.email writer@example.invalid
  git -C /tmp/repo commit --allow-empty -m smoke
  git -C /tmp/repo remote add origin http://native-git:8080/v1/projects/project-a/repositories/root.git
  if git -C /tmp/repo push origin HEAD:refs/heads/proposals/workspace-a/smoke > /tmp/denied.out 2>&1; then exit 1; fi
  if git -C /tmp/repo push origin HEAD:refs/heads/main > /tmp/denied.out 2>&1; then exit 1; fi
'
[[ "$(docker run "${common[@]}" --user 10001:10001 --entrypoint /usr/bin/git \
  --mount "type=volume,src=$native_state_volume,dst=/var/lib/dim-native-git,readonly" "$native_image" \
  --git-dir /var/lib/dim-native-git/project-a/root.git for-each-ref --format='%(refname)')" == "" ]]
printf 'native-active-root-preparation-smoke-ok\n'
docker run --rm --interactive --read-only --network "$service_network" --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges --entrypoint node --mount "$config_mount" \
  "$native_image" --input-type=module <<'EOF'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const native = JSON.parse(readFileSync("/run/fixtures/native-active.json", "utf8"));
const ordinary = JSON.parse(readFileSync("/run/fixtures/ordinary.json", "utf8"));
const writer = JSON.parse(readFileSync("/run/fixtures/writer.json", "utf8")).writer;
const bundle = readFileSync("/run/fixtures/root.bundle");
const commit = readFileSync("/run/fixtures/root.commit", "utf8").trim();
const tree = readFileSync("/run/fixtures/root.tree", "utf8").trim();
const generationId = createHash("sha256").update("native-ready-smoke").digest("hex");
const auth = ({ username, password }) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const origin = "http://native-git:8080";
const endpoint = `${origin}/v1/projects/project-a/root-import`;
const prelude = {
  schemaVersion: 1, generationId, serviceId: "native-main", projectId: "project-a",
  rootRepositoryId: "root", protectedRef: "refs/heads/main", expectedCommit: commit,
  policy: {
    schemaVersion: 1, protectedRef: "refs/heads/main",
    policyRevision: "1260bff66b3d732abb336c2885d6a69a47e465369083c28875dc9cb09a9a480c",
    requiredReviewRevision: "02b474b992388d574069fe2806c9a918f3c660053df4ab6baf595d9d178ea824",
    requiredJobSetRevision: "b9763406fad20f0f816d6346d69d27eb953d7053301bd87275ba73b1f82bc8a1",
    requiredJobs: [{name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled"}],
    requiredReviewerIds: ["owner"],
    pathReviewerRules: []
  }
};
const framed = Buffer.concat([Buffer.from(`${JSON.stringify(prelude)}\n`), bundle]);
const headers = { "content-type": "application/octet-stream", "content-length": String(framed.length) };
const registrarDenied = await fetch(endpoint, { method: "POST", headers: {
  ...headers, authorization: auth(native.projectRegistrars[0])
}, body: framed });
assert.equal(registrarDenied.status, 403);
const importer = native.projectRootImporters[0];
const received = await fetch(endpoint, { method: "POST", headers: {
  ...headers, authorization: auth(importer)
}, body: framed });
assert.equal(received.status, 200);
const receipt = await received.json();
assert.equal(receipt.phase, "bundle-durable");
assert.equal(receipt.expectedCommit, commit);
assert.equal(receipt.bundleDigest, createHash("sha256").update(bundle).digest("hex"));
assert.equal(receipt.bundleSize, bundle.length);
const selector = {
  schemaVersion: 1, generationId, importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest
};
const finalize = () => fetch(`${endpoint}/finalize`, {
  method: "POST", headers: { authorization: auth(importer), "content-type": "application/json" },
  body: JSON.stringify(selector)
});
const finalized = await finalize();
assert.equal(finalized.status, 200);
const result = await finalized.json();
assert.equal(result.phase, "root-imported");
assert.equal(result.expectedCommit, commit);
assert.equal(result.resolvedTree, tree);
assert.equal(result.policyDigest, receipt.policyDigest);
assert.equal(JSON.stringify(result).includes(importer.password), false);
const replay = await finalize();
assert.equal(replay.status, 200);
assert.deepEqual(await replay.json(), result);
const proofEndpoint = `${endpoint}/proof`;
const proof = await fetch(proofEndpoint, { headers: { authorization: auth(importer) } });
assert.equal(proof.status, 200);
assert.equal(proof.headers.get("content-type"), "application/json");
assert.equal(proof.headers.get("cache-control"), "no-store");
assert.deepEqual(await proof.json(), {
  schemaVersion: 2,
  servingGenerationId: generationId,
  ownerHostId: importer.hostId,
  importReceipt: result
});
assert.equal((await fetch(proofEndpoint, {
  headers: { authorization: auth(native.projectRegistrars[0]) }
})).status, 403);
assert.equal((await fetch(`${proofEndpoint}?extra=1`, {
  headers: { authorization: auth(importer) }
})).status, 404);
const transport = await fetch(`${origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-upload-pack`, {
  headers: { authorization: auth(writer) }
});
assert.equal(transport.status, 401);
assert.equal(JSON.stringify(result).includes(ordinary.credentials.registrar.password), false);
EOF
docker run --rm --interactive --read-only --network "$service_network" --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --entrypoint node --mount "$config_mount" "$native_image" --input-type=module <<'EOF'
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const native = JSON.parse(readFileSync("/run/fixtures/native-active.json", "utf8"));
const issuer = native.projectRootReadIssuers[0];
const origin = "http://native-git:8080";
const remote = `${origin}/v1/projects/project-a/repositories/root.git`;
const authorization = (credential) => `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
const discovery = (credential, service) => fetch(`${remote}/info/refs?service=${service}`, {
  headers: { authorization: authorization(credential) }
});
const generationId = createHash("sha256").update("native-ready-smoke").digest("hex");
assert.equal((await discovery(issuer, "git-upload-pack")).status, 403);
const response = await fetch(`${origin}/v1/projects/project-a/root-read-leases`, {
  method: "POST",
  headers: { authorization: authorization(issuer), "content-type": "application/json" },
  body: JSON.stringify({ schemaVersion: 1, generationId })
});
assert.equal(response.status, 201);
assert.equal(response.headers.get("cache-control"), "no-store");
const lease = await response.json();
assert.equal(lease.projectId, "project-a");
assert.equal(lease.rootRepositoryId, "root");
assert.equal(lease.generationId, generationId);
assert.equal((await discovery(lease, "git-receive-pack")).status, 403);
assert.equal((await fetch(`${remote}/git-receive-pack`, {
  method: "POST", headers: {
    authorization: authorization(lease), "content-type": "application/x-git-receive-pack-request"
  }, body: Buffer.alloc(0)
})).status, 403);
assert.equal((await fetch(`${origin}/v1/projects/other/repositories/root.git/info/refs?service=git-upload-pack`, {
  headers: { authorization: authorization(lease) }
})).status, 404);
const gitEnvironment = {
  ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${authorization(lease)}`
};
const git = (args) => spawnSync("/usr/bin/git", args, { encoding: "utf8", env: gitEnvironment });
const advertised = git(["ls-remote", remote, "refs/heads/main"]);
assert.equal(advertised.status, 0, advertised.stderr);
assert.equal(advertised.stdout.trim(), `${readFileSync("/run/fixtures/root.commit", "utf8").trim()}\trefs/heads/main`);
const clone = git(["clone", remote, "/tmp/lease-clone"]);
assert.equal(clone.status, 0, clone.stderr);
assert.equal(readFileSync("/tmp/lease-clone/README.md", "utf8"), "trusted root\n");
assert.equal(git(["-C", "/tmp/lease-clone", "-c", "user.name=DIM", "-c", "user.email=dim@example.invalid",
  "commit", "--allow-empty", "-m", "denied"]).status, 0);
assert.notEqual(git(["-C", "/tmp/lease-clone", "push", remote,
  "HEAD:refs/heads/proposals/workspace-a/denied"]).status, 0);
EOF
expected_commit="$(docker run "${common[@]}" --user 10001:10001 --entrypoint sh \
  --mount "$config_mount" "$native_image" -ec 'IFS= read -r commit < /run/fixtures/root.commit; printf "%s" "$commit"')"
actual_commit="$(docker run "${common[@]}" --user 10001:10001 --entrypoint /usr/bin/git \
  --mount "$native_state_mount" "$native_image" \
  --git-dir /var/lib/dim-native-git/project-a/root.git rev-parse --verify refs/heads/main)"
[[ "$actual_commit" == "$expected_commit" ]]
[[ "$(docker run "${common[@]}" --user 10001:10001 --entrypoint /usr/bin/git \
  --mount "$native_state_mount" "$native_image" \
  --git-dir /var/lib/dim-native-git/project-a/root.git for-each-ref --format='%(refname)')" == "refs/heads/main" ]]
docker container rm --force "$native_service" >/dev/null
docker run --detach --name "$native_service" --network "$service_network" --network-alias native-git \
  --publish 127.0.0.1::8080 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 \
  --mount "type=volume,src=$native_secrets_volume,dst=/run/secrets,readonly" \
  --mount "type=volume,src=$native_state_volume,dst=/var/lib/dim-native-git" \
  "$native_image" serve /run/secrets/service.json "$native_generation" >/dev/null
for _ in {1..100}; do
  docker container exec --user 10001:10001 "$native_service" /usr/local/bin/dim-service ready \
    >"$work_dir/native-import-ready.out" 2>"$work_dir/native-import-ready.err" && break
  sleep 0.05
done
[[ ! -s "$work_dir/native-import-ready.out" && ! -s "$work_dir/native-import-ready.err" ]]
[[ "$(docker run "${common[@]}" --user 10001:10001 --entrypoint /usr/bin/git \
  --mount "$native_state_mount" "$native_image" \
  --git-dir /var/lib/dim-native-git/project-a/root.git rev-parse --verify refs/heads/main)" == "$expected_commit" ]]
[[ "$(docker run "${common[@]}" --user 10001:10001 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --mount "$native_state_mount" "$native_image" check-state --read-only /var/lib/dim-native-git --json)" == \
  '{"schemaVersion":1,"stateFormat":8}' ]]
docker run --rm --interactive --read-only --network "$service_network" --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges --entrypoint node --mount "$config_mount" \
  "$native_image" --input-type=module <<'EOF'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const native = JSON.parse(readFileSync("/run/fixtures/native-active.json", "utf8"));
const importer = native.projectRootImporters[0];
const authorization = `Basic ${Buffer.from(`${importer.username}:${importer.password}`).toString("base64")}`;
const response = await fetch("http://native-git:8080/v1/projects/project-a/root-import/proof", {
  headers: { authorization }
});
assert.equal(response.status, 200);
assert.equal(response.headers.get("cache-control"), "no-store");
const proof = await response.json();
const bundle = readFileSync("/run/fixtures/root.bundle");
const expectedReceipt = {
  schemaVersion: 1, serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root",
  generationId: createHash("sha256").update("native-ready-smoke").digest("hex"),
  protectedRef: "refs/heads/main",
  expectedCommit: readFileSync("/run/fixtures/root.commit", "utf8").trim(),
  resolvedTree: readFileSync("/run/fixtures/root.tree", "utf8").trim(),
  bundleDigest: createHash("sha256").update(bundle).digest("hex"),
  bundleSize: bundle.length, phase: "root-imported"
};
assert.equal(proof.schemaVersion, 2);
assert.equal(proof.servingGenerationId, expectedReceipt.generationId);
assert.equal(proof.ownerHostId, importer.hostId);
for (const [field, value] of Object.entries(expectedReceipt)) assert.equal(proof.importReceipt[field], value);
assert.match(proof.importReceipt.policyDigest, /^[0-9a-f]{64}$/);
assert.match(proof.importReceipt.importNonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.deepEqual(Object.keys(proof).sort(), ["schemaVersion", "servingGenerationId", "ownerHostId", "importReceipt"].sort());
assert.deepEqual(Object.keys(proof.importReceipt).sort(),
  [...Object.keys(expectedReceipt), "policyDigest", "importNonce"].sort());
EOF
docker run --rm --read-only --network "$service_network" --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --entrypoint sh --mount "$config_mount" "$native_image" -ec '
  export GIT_ASKPASS=/run/fixtures/writer-askpass GIT_TERMINAL_PROMPT=0 HOME=/tmp
  remote=http://native-git:8080/v1/projects/project-a/repositories/root.git
  if git ls-remote "$remote" refs/heads/main > /tmp/denied.out 2>&1; then exit 1; fi
  git init --initial-branch=main /tmp/repo >/dev/null
  git -C /tmp/repo config user.name DIM
  git -C /tmp/repo config user.email writer@example.invalid
  git -C /tmp/repo commit --allow-empty -m smoke >/dev/null
  if git -C /tmp/repo push "$remote" HEAD:refs/heads/proposals/workspace-a/after-restart \
    > /tmp/denied.out 2>&1; then exit 1; fi
'
[[ "$(docker run "${common[@]}" --user 10001:10001 --entrypoint /usr/bin/git \
  --mount "$native_state_mount" "$native_image" \
  --git-dir /var/lib/dim-native-git/project-a/root.git for-each-ref --format='%(refname)')" == "refs/heads/main" ]]
printf 'native-active-root-import-smoke-ok commit=%s\n' "$actual_commit"
docker container rm --force "$native_service" >/dev/null
docker run --rm --interactive --user 0:0 --entrypoint sh \
  --mount "type=volume,src=$native_secrets_volume,dst=/run/secrets" "$ordinary_image" \
  -ec 'cat > /run/secrets/activation.token && chmod 0444 /run/secrets/activation.token' \
  <"$work_dir/native-activation-b.token"
native_generation_b="$(printf native-candidate-smoke | sha256sum | cut -d ' ' -f 1)"
docker run --detach --name "$native_service" --network "$service_network" --network-alias native-git \
  --publish 127.0.0.1::8080 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 \
  --mount "type=volume,src=$native_secrets_volume,dst=/run/secrets,readonly" \
  --mount "type=volume,src=$native_state_volume,dst=/var/lib/dim-native-git" \
  "$native_image" serve /run/secrets/service.json "$native_generation_b" >/dev/null
for _ in {1..100}; do
  docker container exec --user 10001:10001 "$native_service" /usr/local/bin/dim-service ready \
    >"$work_dir/native-candidate-ready.out" 2>"$work_dir/native-candidate-ready.err" && break
  sleep 0.05
done
[[ ! -s "$work_dir/native-candidate-ready.out" && ! -s "$work_dir/native-candidate-ready.err" ]]
docker run --rm --interactive --read-only --network "$service_network" --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges --entrypoint node --mount "$config_mount" \
  "$native_image" --input-type=module <<'EOF'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const native = JSON.parse(readFileSync("/run/fixtures/native-active.json", "utf8"));
const auth = ({ username, password }) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const origin = "http://native-git:8080/v1/projects/project-a";
const generationId = createHash("sha256").update("native-candidate-smoke").digest("hex");
const proof = await fetch(`${origin}/root-import/proof`, {
  headers: { authorization: auth(native.projectRootImporters[0]) }
});
assert.equal(proof.status, 503);
const lease = await fetch(`${origin}/root-read-leases`, {
  method: "POST", headers: {
    authorization: auth(native.projectRootReadIssuers[0]), "content-type": "application/json"
  }, body: JSON.stringify({ schemaVersion: 1, generationId })
});
assert.equal(lease.status, 503);
EOF
docker container exec --user 10001:10001 "$native_service" /usr/local/bin/dim-service activate "$native_generation_b"
docker run --rm --interactive --read-only --network "$service_network" --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges --entrypoint node --mount "$config_mount" \
  "$native_image" --input-type=module <<'EOF'
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const native = JSON.parse(readFileSync("/run/fixtures/native-active.json", "utf8"));
const auth = ({ username, password }) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const origin = "http://native-git:8080/v1/projects/project-a";
const originalGeneration = createHash("sha256").update("native-ready-smoke").digest("hex");
const servingGeneration = createHash("sha256").update("native-candidate-smoke").digest("hex");
const proof = await fetch(`${origin}/root-import/proof`, {
  headers: { authorization: auth(native.projectRootImporters[0]) }
});
assert.equal(proof.status, 200);
const imported = await proof.json();
assert.equal(imported.schemaVersion, 2);
assert.equal(imported.servingGenerationId, servingGeneration);
assert.equal(imported.ownerHostId, "host-a");
assert.equal(imported.importReceipt.generationId, originalGeneration);
assert.equal(imported.importReceipt.expectedCommit, readFileSync("/run/fixtures/root.commit", "utf8").trim());
assert.equal(imported.importReceipt.resolvedTree, readFileSync("/run/fixtures/root.tree", "utf8").trim());
assert.equal(imported.importReceipt.bundleDigest,
  createHash("sha256").update(readFileSync("/run/fixtures/root.bundle")).digest("hex"));
assert.equal(imported.importReceipt.phase, "root-imported");
const requested = await fetch(`${origin}/root-read-leases`, {
  method: "POST", headers: {
    authorization: auth(native.projectRootReadIssuers[0]), "content-type": "application/json"
  }, body: JSON.stringify({ schemaVersion: 1, generationId: servingGeneration })
});
assert.equal(requested.status, 201);
const lease = await requested.json();
assert.equal(lease.generationId, servingGeneration);
const remote = `${origin}/repositories/root.git`;
const fetched = spawnSync("/usr/bin/git", ["ls-remote", remote, "refs/heads/main"], {
  encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${auth(lease)}` }
});
assert.equal(fetched.status, 0, fetched.stderr);
assert.equal(fetched.stdout.trim(), `${imported.importReceipt.expectedCommit}\trefs/heads/main`);
EOF
[[ "$(docker run "${common[@]}" --user 10001:10001 --entrypoint /usr/bin/git \
  --mount "$native_state_mount" "$native_image" \
  --git-dir /var/lib/dim-native-git/project-a/root.git rev-parse --verify refs/heads/main)" == "$expected_commit" ]]
[[ "$(docker run "${common[@]}" --user 10001:10001 --entrypoint /usr/bin/git \
  --mount "$native_state_mount" "$native_image" \
  --git-dir /var/lib/dim-native-git/project-a/root.git for-each-ref --format='%(refname)')" == "refs/heads/main" ]]
printf 'native-imported-root-generation-rollover-smoke-ok commit=%s\n' "$expected_commit"
docker run --rm --interactive --read-only --network "$service_network" --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --entrypoint node --mount "$config_mount" "$native_image" --input-type=module <<'EOF'
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const native = JSON.parse(readFileSync("/run/fixtures/native-active.json", "utf8"));
const issuer = native.workspaceWriteIssuers[0];
const workspaceId = Buffer.alloc(32, 60).toString("base64url");
const generationId = createHash("sha256").update("native-candidate-smoke").digest("hex");
const authorization = ({ username, password }) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const origin = "http://native-git:8080/v1/projects/project-a";
const response = await fetch(`${origin}/workspace-write-leases`, {
  method: "POST", headers: { authorization: authorization(issuer), "content-type": "application/json" },
  body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root", workspaceId })
});
assert.equal(response.status, 201);
assert.equal(response.headers.get("cache-control"), "no-store");
const lease = await response.json();
assert.equal(lease.workspaceId, workspaceId);
const remote = `${origin}/repositories/root.git`;
const git = (args) => spawnSync("/usr/bin/git", args, { encoding: "utf8", env: {
  ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${authorization(lease)}`
} });
const clone = git(["clone", remote, "/tmp/write-clone"]);
assert.equal(clone.status, 0, clone.stderr);
const committed = git(["-C", "/tmp/write-clone", "-c", "user.name=DIM", "-c",
  "user.email=dim@example.invalid", "commit", "--allow-empty", "-m", "proposal"]);
assert.equal(committed.status, 0, committed.stderr);
const proposalRef = `refs/heads/proposals/${workspaceId}/change`;
const pushed = git(["-C", "/tmp/write-clone", "push", remote, `HEAD:${proposalRef}`]);
assert.equal(pushed.status, 0, pushed.stderr);
assert.notEqual(git(["-C", "/tmp/write-clone", "push", remote, "HEAD:refs/heads/main"]).status, 0);
const proof = await fetch(`${origin}/root-import/proof`, {
  headers: { authorization: authorization(native.projectRootImporters[0]) }
});
assert.equal(proof.status, 200);
assert.equal((await proof.json()).importReceipt.expectedCommit,
  readFileSync("/run/fixtures/root.commit", "utf8").trim());
EOF
printf 'native-workspace-proposal-smoke-ok\n'
published_port="$(docker container port "$ordinary_service" 8080/tcp | cut -d: -f2)"
set +e
curl --fail --silent --max-time 1 "http://127.0.0.1:$published_port/readyz" >/dev/null 2>&1
curl_status=$?
set -e
[[ "$curl_status" -eq 7 ]]

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
