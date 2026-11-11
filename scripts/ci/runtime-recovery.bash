#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${DIM_ARTIFACTS_DIR:-}" == /workspace/.dim-ci-artifacts ]] || { echo 'scheduler artifact directory required' >&2; exit 2; }
node scripts/ci/practical-source.ts
sudo bash scripts/checks/lib/install-source-tools-ubuntu.bash
export PATH=/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin:/usr/local/lib/dim-qemu-node-24.19.0/bin:$PATH
pnpm install --frozen-lockfile
pnpm --filter @slop-lab/dim-host-core... run build
pnpm --filter @slop-lab/dim-host-core run check
pnpm --dir tests run check
pnpm run check:tools
pnpm --dir tests exec vitest run host/core/workspaceBootIdentity.test.ts host/core/workspaceReadiness.test.ts host/core/workspaceDoctor.test.ts
DIM_HOST_INSTALL_ASSUME_YES=1 bash scripts/checks/install-host-ubuntu.bash sysbox docker-ce
mkdir -p "$DIM_ARTIFACTS_DIR"
sudo -H -u "$(id -un)" env PATH="$PATH" DIM_PLUGIN_HOME="$DIM_ARTIFACTS_DIR/empty-plugin-home" timeout 1800 \
  node --conditions=dim-source --import ./tests/node_modules/tsx/dist/loader.mjs \
  scripts/checks/workspace-runtime-recovery.ts "$DIM_ARTIFACTS_DIR/runtime-recovery"
