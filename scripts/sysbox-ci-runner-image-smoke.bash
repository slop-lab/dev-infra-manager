#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-sysbox-ci-runner-image.XXXXXX)"
cleanup() { find "$work_dir" -depth -delete 2>/dev/null || true; }
trap cleanup EXIT

pnpm --dir "$repo_root/core/packages/core" run build >/dev/null
node --input-type=module - "$work_dir/Dockerfile" "$work_dir/config.yml" "$repo_root/core/packages/core/dist/sysboxCiRunnerAssets.js" <<'EOF'
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { SYSBOX_CI_RUNNER_CONFIG, SYSBOX_CI_RUNNER_DOCKERFILE } = await import(pathToFileURL(process.argv[4]).href);
await writeFile(process.argv[2], SYSBOX_CI_RUNNER_DOCKERFILE);
await writeFile(process.argv[3], SYSBOX_CI_RUNNER_CONFIG);
EOF

image="dim-sysbox-ci-runner-smoke:$$"
docker build --quiet --tag "$image" "$work_dir" >/dev/null
trap 'docker image rm --force "$image" >/dev/null 2>&1 || true; cleanup' EXIT
docker run --rm --entrypoint sh "$image" -ec '
  act_runner --version
  test -s /etc/dim-act-runner.yml
  for tool in node git docker just jq socat script; do
    ! command -v "$tool"
  done
' >/dev/null

echo sysbox-ci-runner-image-smoke-ok
