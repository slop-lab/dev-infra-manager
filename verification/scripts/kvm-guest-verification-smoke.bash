#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
source "$script_dir/lib/verification-stage-runner.bash"
DIM_VERIFICATION_STAGE_ENTRYPOINT="$script_dir/kvm-guest-verification-smoke.bash"
export DIM_VERIFICATION_STAGE_ENTRYPOINT

if [[ -n "${DIM_VERIFICATION_INTERNAL_STAGE:-}" ]]; then
  [[ -n "${DIM_VERIFICATION_LOG_ROOT:-}" && -d "$DIM_VERIFICATION_LOG_ROOT" ]] || {
    printf 'internal verification stage requires an existing DIM_VERIFICATION_LOG_ROOT\n' >&2
    exit 2
  }
else
  DIM_VERIFICATION_LOG_ROOT="${DIM_KVM_GUEST_LOG_ROOT:-/tmp/dim-native-guest-logs/$(date -u +%Y%m%dT%H%M%SZ)-$$}"
fi
export DIM_VERIFICATION_LOG_ROOT

source_ready() {
  command -v node >/dev/null
  command -v pnpm >/dev/null
  command -v just >/dev/null
}

docker_ready() {
  command -v docker >/dev/null
  docker info >/dev/null
  docker compose version >/dev/null
}

sysbox_ready() {
  docker info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"'
}

kvm_ready() {
  [[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || {
    printf 'native guest verification requires accessible KVM; hardware absence is unavailable\n' >&2
    return 2
  }
}

native_contracts() {
  cd "$repo_root"
  pnpm --filter @slop-lab/dim-core run build
  pnpm --filter @slop-lab/dim-native-git run build
  pnpm --filter @slop-lab/dim-cli run build
  pnpm --dir verification exec vitest run \
    test/nativeCutoverCleanHost.test.mjs \
    test/nativeCutoverPolicyMatrix.test.mjs \
    test/nativeCutoverQemuPreflight.test.mjs \
    test/nativeBasicExample.test.mjs \
    test/nativeBasicLifecycleSmoke.test.mjs \
    test/candidateSourceWorkflow.test.ts
}

installed_services() {
  cd "$repo_root"
  just verify native-idle-service-images
  just verify control-plane-install-live
}

ordinary_mechanics() {
  cd "$repo_root"
  just verify native-ordinary-guest-mechanics
}

native_basic_lifecycle() {
  cd "$repo_root"
  just verify native-basic-lifecycle
}

qemu_mechanics() {
  cd "$repo_root"
  just verify native-qemu-guest-mechanics-kvm
}

verification_stage_register source-ready source_ready ""
verification_stage_register docker-ready docker_ready ""
verification_stage_register sysbox-ready sysbox_ready "docker-ready"
verification_stage_register kvm-ready kvm_ready "docker-ready"
verification_stage_register native-contracts native_contracts "source-ready"
verification_stage_register installed-services installed_services "source-ready docker-ready"
verification_stage_register ordinary-sysbox-mechanics ordinary_mechanics "docker-ready sysbox-ready"
verification_stage_register native-basic-lifecycle native_basic_lifecycle "source-ready docker-ready sysbox-ready"
verification_stage_register qemu-kvm-mechanics qemu_mechanics "docker-ready kvm-ready"
if [[ -n "${DIM_VERIFICATION_INTERNAL_STAGE:-}" ]]; then
  verification_stage_run_internal "$DIM_VERIFICATION_INTERNAL_STAGE"
  exit
fi
verification_stage_run
