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

runner_digest="docker@sha256:173f284a4299164772a90f52b373e73e087583c0963f1334c9995f190ef6f3f5"
job_digest="node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df"

cd "$root_dir"
DIM_TEST_NATIVE_RUNNER_IMAGE="$runner_digest" DIM_TEST_NATIVE_JOB_IMAGE="$job_digest" \
  pnpm --dir verification exec vitest run --config live/vitest.config.ts live/nativeOrdinaryExecutorLive.test.ts
printf '{"schemaVersion":1,"classification":"same-host-native-mechanics-not-independent-acceptance","runtime":"sysbox-runc","runnerImage":"%s","jobImage":"%s"}\n' \
  "$runner_digest" "$job_digest"
printf '%s\n' native-ordinary-guest-mechanics-smoke-ok
