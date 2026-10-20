#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-service-images.XXXXXX)"
native_image="dim-native-service-smoke:$$"
ci_image="dim-ci-service-smoke:$$"
native_container="dim-native-service-smoke-$$"
ci_container="dim-ci-service-smoke-$$"
native_state="dim-native-service-state-$$"
ci_state="dim-ci-service-state-$$"
network="dim-service-smoke-$$"
cleanup() {
  docker rm --force "$native_container" "$ci_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$native_state" "$ci_state" >/dev/null 2>&1 || true
  docker image rm "$native_image" "$ci_image" >/dev/null 2>&1 || true
  rm -rf -- "$work_dir"
}
trap cleanup EXIT
cd -- "$repo_root"
docker info >/dev/null
"$repo_root/scripts/checks/lib/check-installation-docker-version.bash" "$(docker version --format '{{.Server.Version}}')"
# Callers with a protected, matched build can verify those exact artifacts without cleaning dist.
if [[ "${DIM_VERIFY_SKIP_BUILD:-0}" != 1 ]]; then
  pnpm --filter '@this-project/control-plane-deployment...' --filter '@slop-lab/dim-control-plane-plugin-ci...' --workspace-concurrency=1 run build >/dev/null
fi
node --input-type=module - "$work_dir" <<'JS'
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareControlPlane } from './packages/control-plane/admin/dist/controlPlaneSetup.js';
const root = process.argv[2], prepared = join(root, 'prepared');
await prepareControlPlane({ directory: prepared, nativeGitImage: `test/native@sha256:${'a'.repeat(64)}`,
  ordinaryCiImage: `test/ci@sha256:${'b'.repeat(64)}` });
for (const [name, source] of [['native', 'native-git'], ['ci', 'ordinary-ci']]) {
  const directory = join(root, name); await mkdir(directory, { mode: 0o755 });
  await copyFile(join(prepared, `${source}.json`), join(directory, 'service.json'));
  await copyFile(join(prepared, `${source}-readiness.token`), join(directory, 'readiness.token'));
  await writeFile(join(directory, 'activation.token'), `${randomBytes(32).toString('base64url')}\n`);
  for (const file of ['service.json', 'readiness.token', 'activation.token']) await chmod(join(directory, file), 0o444);
}
await writeFile(join(root, 'generation'), randomBytes(32).toString('hex'));
JS
generation="$(cat "$work_dir/generation")"
docker build --tag "$native_image" --file packages/control-plane/deployment/image/Dockerfile . >/dev/null
docker build --tag "$ci_image" --file packages/control-plane/plugins/ci/image/Dockerfile . >/dev/null
docker image inspect --format 'Verified image {{.Id}}' "$native_image" "$ci_image"
docker network create "$network" >/dev/null
docker volume create "$native_state" >/dev/null
docker volume create "$ci_state" >/dev/null
common=(--detach --read-only --cap-drop ALL --security-opt no-new-privileges
  --network "$network" --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m --publish 127.0.0.1::8080)
docker run "${common[@]}" --name "$native_container" --network-alias native-git \
  --mount "type=bind,src=$work_dir/native,dst=/run/secrets,readonly" \
  --mount "type=volume,src=$native_state,dst=/var/lib/dim-native-git" \
  "$native_image" serve /run/secrets/service.json "$generation" >/dev/null
docker run "${common[@]}" --name "$ci_container" --network-alias ordinary-ci \
  --mount "type=bind,src=$work_dir/ci,dst=/run/secrets,readonly" \
  --mount "type=volume,src=$ci_state,dst=/var/lib/dim-ordinary-ci" \
  "$ci_image" serve /run/secrets/service.json "$generation" >/dev/null
for container in "$native_container" "$ci_container"; do
  ready=false
  for _ in {1..30}; do
    if docker exec "$container" dim-service ready >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then docker logs "$container" >&2; exit 1; fi
  docker exec "$container" node --input-type=module -e '
    import assert from "node:assert/strict";
    import { readdirSync } from "node:fs";
    const expected = ["dim-contracts-ci", "dim-contracts-git", "dim-control-plane-plugin-ci"];
    if (process.argv[1] === "native") expected.splice(2, 1,
      "dim-control-plane-core", "dim-control-plane-admin", "dim-control-plane-plugin-ci-workflows",
      "dim-control-plane-plugin-git-repositories", "dim-control-plane-plugin-code-review",
      "dim-control-plane-plugin-merge-policy", "dim-control-plane-plugin-git-ci", "dim-control-plane-plugin-webhooks");
    assert.deepEqual(readdirSync("/usr/local/lib/dim/node_modules/@slop-lab").sort(), expected.sort(),
      "service image must contain only its reviewed control-plane dependency closure");
  ' "$([[ "$container" == "$native_container" ]] && printf native || printf ci)"
done
ci_port="$(docker port "$ci_container" 8080/tcp)"
node --input-type=module - "$work_dir" "http://$ci_port" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(`${process.argv[2]}/ci/service.json`, 'utf8'));
const credential = config.credentials.query;
const response = await fetch(`${process.argv[3]}/v1/jobs`, {
  headers: { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
    'X-Dim-Generation-Id': await readFile(`${process.argv[2]}/generation`, 'utf8') }
});
assert.equal(response.status, 503, 'business operations must require exact generation activation');
JS
for container in "$native_container" "$ci_container"; do docker exec "$container" dim-service activate "$generation"; done
node --input-type=module - "$work_dir" "http://$ci_port" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(`${process.argv[2]}/ci/service.json`, 'utf8'));
const credential = config.credentials.query;
const response = await fetch(`${process.argv[3]}/v1/jobs`, {
  headers: { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
    'X-Dim-Generation-Id': await readFile(`${process.argv[2]}/generation`, 'utf8') }
});
assert.equal(response.status, 200); assert.deepEqual(await response.json(), []);
JS
for container in "$native_container" "$ci_container"; do docker stop --time 15 "$container" >/dev/null; done
for kind in native ci; do
  if [[ "$kind" == native ]]; then image="$native_image"; state="$native_state"; target=/var/lib/dim-native-git; format=10;
  else image="$ci_image"; state="$ci_state"; target=/var/lib/dim-ordinary-ci; format=102; fi
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
printf '%s\n' 'NativeGit + shared CI images: readiness, activation, query and read-only state inspection passed.'
