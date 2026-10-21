#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-service-images.XXXXXX)"
native_image="dim-native-service-smoke:$$"
execution_image="dim-execution-scheduler-smoke:$$"
native_container="dim-native-service-smoke-$$"
execution_container="dim-execution-scheduler-smoke-$$"
native_state="dim-native-service-state-$$"
execution_state="dim-execution-scheduler-state-$$"
network="dim-service-smoke-$$"
cleanup() {
  docker rm --force "$native_container" "$execution_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$native_state" "$execution_state" >/dev/null 2>&1 || true
  docker image rm "$native_image" "$execution_image" >/dev/null 2>&1 || true
  rm -rf -- "$work_dir"
}
trap cleanup EXIT
cd -- "$repo_root"
docker info >/dev/null
"$repo_root/scripts/checks/lib/check-installation-docker-version.bash" "$(docker version --format '{{.Server.Version}}')"
# Callers with a protected, matched build can verify those exact artifacts without cleaning dist.
if [[ "${DIM_VERIFY_SKIP_BUILD:-0}" != 1 ]]; then
  pnpm --filter '@this-project/control-plane-deployment...' --filter '@slop-lab/dim-control-plane-plugin-execution-scheduler...' --workspace-concurrency=1 run build >/dev/null
fi
node --input-type=module - "$work_dir" <<'JS'
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareControlPlane } from './packages/control-plane/admin/dist/controlPlaneSetup.js';
const root = process.argv[2], prepared = join(root, 'prepared');
await prepareControlPlane({ directory: prepared, nativeGitImage: `test/native@sha256:${'a'.repeat(64)}`,
  executionImage: `test/execution@sha256:${'b'.repeat(64)}` });
for (const [name, source] of [['native', 'native-git'], ['execution', 'execution']]) {
  const directory = join(root, name); await mkdir(directory, { mode: 0o755 });
  await copyFile(join(prepared, `${source}.json`), join(directory, 'service.json'));
  await copyFile(join(prepared, `${source}-readiness.token`), join(directory, 'readiness.token'));
  await writeFile(join(directory, 'activation.token'), `${randomBytes(32).toString('base64url')}\n`);
  for (const file of ['service.json', 'readiness.token', 'activation.token']) await chmod(join(directory, file), 0o444);
}
await writeFile(join(root, 'generation'), randomBytes(32).toString('hex'));
JS
generation="$(cat "$work_dir/generation")"
node packages/control-plane/deployment/image/build.ts "$native_image" >/dev/null
node packages/control-plane/plugins/execution-scheduler/image/build.ts "$execution_image" >/dev/null
docker image inspect --format 'Verified image {{.Id}}' "$native_image" "$execution_image"
# Exercise the config-only scheduler subpath from the curated native image.
docker run --rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$work_dir/native/service.json,dst=/run/native.json,readonly" \
  --mount "type=bind,src=$work_dir/execution/service.json,dst=/run/execution.json,readonly" \
  "$native_image" check-bundle-config /run/native.json /run/execution.json
docker network create "$network" >/dev/null
docker volume create "$native_state" >/dev/null
docker volume create "$execution_state" >/dev/null
common=(--detach --read-only --cap-drop ALL --security-opt no-new-privileges
  --network "$network" --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m --publish 127.0.0.1::8080)
docker run "${common[@]}" --name "$native_container" --network-alias native-git \
  --mount "type=bind,src=$work_dir/native,dst=/run/secrets,readonly" \
  --mount "type=volume,src=$native_state,dst=/var/lib/dim-native-git" \
  "$native_image" serve /run/secrets/service.json "$generation" >/dev/null
docker run "${common[@]}" --name "$execution_container" --network-alias execution \
  --mount "type=bind,src=$work_dir/execution,dst=/run/secrets,readonly" \
  --mount "type=volume,src=$execution_state,dst=/var/lib/dim-execution" \
  "$execution_image" serve /run/secrets/service.json "$generation" >/dev/null
for container in "$native_container" "$execution_container"; do
  ready=false
  for _ in {1..30}; do
    if docker exec "$container" dim-service ready >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then docker logs "$container" >&2; exit 1; fi
  docker exec "$container" node --input-type=module -e '
    import assert from "node:assert/strict";
    import { readdirSync } from "node:fs";
    const expected = ["dim-contracts-ci", "dim-contracts-git", "dim-contracts-execution", "dim-control-plane-plugin-execution-scheduler"];
    if (process.argv[1] !== "native") expected.push("dim-execution-scheduler");
    if (process.argv[1] === "native") expected.push(
      "dim-control-plane-core", "dim-control-plane-admin", "dim-control-plane-plugin-ci-workflows",
      "dim-control-plane-plugin-git-repositories", "dim-control-plane-plugin-code-review",
      "dim-control-plane-plugin-merge-policy", "dim-control-plane-plugin-git-ci", "dim-control-plane-plugin-webhooks");
    assert.deepEqual(readdirSync("/usr/local/lib/dim/node_modules/@slop-lab").sort(), expected.sort(),
      "service image must contain only its reviewed control-plane dependency closure");
  ' "$([[ "$container" == "$native_container" ]] && printf native || printf execution)"
done
execution_port="$(docker port "$execution_container" 8080/tcp)"
node --input-type=module - "$work_dir" "http://$execution_port" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(`${process.argv[2]}/execution/service.json`, 'utf8'));
const credential = config.credentials.query;
const response = await fetch(`${process.argv[3]}/v1/jobs`, {
  headers: { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
    'X-Dim-Generation-Id': await readFile(`${process.argv[2]}/generation`, 'utf8') }
});
assert.equal(response.status, 503, 'business operations must require exact generation activation');
JS
for container in "$native_container" "$execution_container"; do docker exec "$container" dim-service activate "$generation"; done
node --input-type=module - "$work_dir" "http://$execution_port" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(`${process.argv[2]}/execution/service.json`, 'utf8'));
const credential = config.credentials.query;
const response = await fetch(`${process.argv[3]}/v1/jobs`, {
  headers: { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
    'X-Dim-Generation-Id': await readFile(`${process.argv[2]}/generation`, 'utf8') }
});
assert.equal(response.status, 200); assert.deepEqual(await response.json(), []);
JS
for container in "$native_container" "$execution_container"; do docker stop --time 15 "$container" >/dev/null; done
for kind in native execution; do
  if [[ "$kind" == native ]]; then image="$native_image"; state="$native_state"; target=/var/lib/dim-native-git; format=10;
  else image="$execution_image"; state="$execution_state"; target=/var/lib/dim-execution; format=102; fi
  compatibility="$(docker run --rm --read-only --network none "$image" compatibility --json)"
  inspected="$(docker run --rm --read-only --network none --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
    --mount "type=volume,src=$state,dst=$target,readonly" "$image" check-state --read-only "$target" --json)"
  node --input-type=module - "$compatibility" "$inspected" "$format" <<'JS'
import assert from 'node:assert/strict';
const expected = Number(process.argv[4]);
assert.deepEqual(JSON.parse(process.argv[2]), { schemaVersion: 1, writeFormat: expected, readableFormats: [expected] });
assert.deepEqual(JSON.parse(process.argv[3]), { schemaVersion: 1, stateFormat: expected });
JS
done
printf '%s\n' 'NativeGit + shared execution images: readiness, activation, query and read-only state inspection passed.'
