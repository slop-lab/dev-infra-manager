#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-sysbox-ci-runner-image.XXXXXX)"
cleanup() { find "$work_dir" -depth -delete 2>/dev/null || true; }
trap cleanup EXIT

pnpm --dir "$repo_root/core/packages/core" run build >/dev/null
node --input-type=module - "$work_dir/Dockerfile" "$work_dir/health.bash" <<'EOF'
import { writeFile } from "node:fs/promises";
import { SYSBOX_CI_RUNNER_DOCKERFILE, SYSBOX_CI_RUNNER_HEALTH_SCRIPT } from "./core/packages/core/dist/sysboxCiRunnerAssets.js";
await writeFile(process.argv[2], SYSBOX_CI_RUNNER_DOCKERFILE);
await writeFile(process.argv[3], SYSBOX_CI_RUNNER_HEALTH_SCRIPT);
EOF

image="dim-sysbox-ci-runner-smoke:$$"
docker build --quiet --tag "$image" "$work_dir" >/dev/null
trap 'docker image rm --force "$image" >/dev/null 2>&1 || true; cleanup' EXIT
docker run --rm --entrypoint sh "$image" -ec '
  node --version
  git --version
  docker --version
  act_runner --version
  bash -n /usr/local/bin/dim-ci-runner-health
' >/dev/null

echo sysbox-ci-runner-image-smoke-ok
