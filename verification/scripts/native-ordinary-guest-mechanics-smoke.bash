#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
for command in docker pnpm; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 2; }
done
docker info >/dev/null 2>&1 || { printf 'a reachable Docker daemon is required\n' >&2; exit 2; }
docker info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"' || {
  printf 'native ordinary mechanics require registered sysbox-runc\n' >&2
  exit 2
}

work_dir="$(mktemp -d /tmp/dim-native-ordinary.XXXXXX)"
suffix="$(basename "$work_dir" | tr '[:upper:]' '[:lower:]')"
registry="dim-native-ordinary-registry-$suffix"
runner_tag=""
job_tag=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  [[ -z "$runner_tag" ]] || docker image rm --force "$runner_tag" >/dev/null 2>&1
  [[ -z "$job_tag" ]] || docker image rm --force "$job_tag" >/dev/null 2>&1
  docker container rm --force "$registry" >/dev/null 2>&1
  rm -rf -- "$work_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker run --detach --name "$registry" --label dim.verification=native-ordinary-mechanics \
  --publish 127.0.0.1::5000 registry:3 >/dev/null
port="$(docker port "$registry" 5000/tcp | sed -n 's/^127\.0\.0\.1://p')"
[[ "$port" =~ ^[0-9]+$ ]] || { printf 'local fixture registry did not publish an IPv4 port\n' >&2; exit 1; }
registry_origin="127.0.0.1:$port"

cat >"$work_dir/runner.Dockerfile" <<'EOF'
FROM docker:29.1.3-dind
EOF
cat >"$work_dir/job.Dockerfile" <<'EOF'
FROM alpine:3.22.2
RUN apk add --no-cache bash
EOF
runner_tag="$registry_origin/native-runner:$suffix"
job_tag="$registry_origin/native-job:$suffix"
docker build --quiet --file "$work_dir/runner.Dockerfile" --tag "$runner_tag" "$work_dir" >/dev/null
docker build --quiet --file "$work_dir/job.Dockerfile" --tag "$job_tag" "$work_dir" >/dev/null
docker push "$runner_tag" >/dev/null
docker push "$job_tag" >/dev/null
runner_digest="$(docker image inspect "$runner_tag" --format '{{index .RepoDigests 0}}')"
job_digest="$(docker image inspect "$job_tag" --format '{{index .RepoDigests 0}}')"
[[ "$runner_digest" =~ @sha256:[0-9a-f]{64}$ && "$job_digest" =~ @sha256:[0-9a-f]{64}$ ]]

cd "$root_dir"
DIM_TEST_NATIVE_RUNNER_IMAGE="$runner_digest" DIM_TEST_NATIVE_JOB_IMAGE="$job_digest" \
  pnpm --dir verification exec vitest run --config live/vitest.config.ts live/nativeOrdinaryExecutorLive.test.ts
printf '{"schemaVersion":1,"classification":"same-host-native-mechanics-not-independent-acceptance","runtime":"sysbox-runc","runnerImage":"%s","jobImage":"%s"}\n' \
  "$runner_digest" "$job_digest"
printf '%s\n' native-ordinary-guest-mechanics-smoke-ok
