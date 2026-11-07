#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${DIM_ARTIFACTS_DIR:-}" == /workspace/.dim-ci-artifacts ]] || { echo 'explicit scheduler artifact directory required' >&2; exit 2; }
node scripts/ci/practical-source.ts
sudo bash scripts/checks/lib/install-source-tools-ubuntu.bash
export PATH=/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin:/usr/local/lib/dim-qemu-node-24.19.0/bin:$PATH
pnpm install --frozen-lockfile
just build-packages
# Credential-bearing fixture state remains private. Export only reviewed evidence.
private_evidence="$(mktemp -d /tmp/dim-practical-evidence.XXXXXXXX)"
export DIM_EXAMPLES_VM_LOG_ROOT="$private_evidence"
export_evidence() {
  status=$?
  trap - EXIT
  node scripts/ci/practical-artifacts.ts "$private_evidence" "$DIM_ARTIFACTS_DIR" "$status" || status=1
  rm -rf -- "$private_evidence"
  exit "$status"
}
trap export_evidence EXIT
bash scripts/checks/examples-vm-smoke.bash
node tests/scenarios/selected-host/ci/verifyEvidence.ts "$private_evidence" "$(git rev-parse HEAD)" "$(git rev-parse 'HEAD^{tree}')"
