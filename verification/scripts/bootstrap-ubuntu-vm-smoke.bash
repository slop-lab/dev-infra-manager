#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/bootstrap-ubuntu-vm-source.bash"
source "$script_dir/lib/bootstrap-ubuntu-vm-guest.bash"

if bootstrap_source_parse "$@"; then
  :
else
  status=$?
  [[ "$status" -eq 64 ]] && exit 0
  exit "$status"
fi

for command in cloud-localds curl git node python3 qemu-img qemu-system-x86_64 \
  scp sha256sum ssh ssh-keygen timeout; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 2; }
done
[[ "$(uname -m)" == x86_64 ]] || { printf '%s\n' 'fresh Ubuntu VM acceptance requires x86-64' >&2; exit 2; }
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || {
  printf '%s\n' 'fresh Ubuntu VM acceptance requires accessible KVM; TCG is forbidden' >&2
  exit 2
}

readonly BOOTSTRAP_IMAGE_URL=https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img
readonly BOOTSTRAP_IMAGE_SHA256=6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2
BOOTSTRAP_WORK_ROOT="$(mktemp -d /tmp/dim-bootstrap-ubuntu-vm.XXXXXXXX)"
BOOTSTRAP_WORK_IDENTITY="$(stat -Lc '%d:%i' "$BOOTSTRAP_WORK_ROOT")"
BOOTSTRAP_EVIDENCE_ROOT="${DIM_BOOTSTRAP_VM_LOG_ROOT:-$PWD/.local/verification/bootstrap-ubuntu-vm-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
BOOTSTRAP_BASE_IMAGE=""
BOOTSTRAP_CLEANUP_COMPLETE=0
BOOTSTRAP_CLEANUP_UNCERTAIN=0
export BOOTSTRAP_WORK_ROOT BOOTSTRAP_EVIDENCE_ROOT BOOTSTRAP_BASE_IMAGE
umask 077
mkdir -p "$BOOTSTRAP_EVIDENCE_ROOT"
chmod 0700 "$BOOTSTRAP_EVIDENCE_ROOT"

bootstrap_cleanup() {
  local status=$? cleanup_status=0
  trap - EXIT INT TERM
  if [[ "$status" -ne 0 ]]; then
    for log in "$BOOTSTRAP_EVIDENCE_ROOT"/*-console.log \
      "$BOOTSTRAP_EVIDENCE_ROOT"/*-bootstrap-pass1.log "$BOOTSTRAP_EVIDENCE_ROOT"/*-bootstrap-pass2.log \
      "$BOOTSTRAP_EVIDENCE_ROOT"/*-control-plane-install.log "$BOOTSTRAP_EVIDENCE_ROOT"/*-native-basic-lifecycle.log; do
      [[ -f "$log" ]] || continue
      printf '\nfailed fresh Ubuntu VM diagnostic: %s\n' "$log" >&2
      tail -c 4096 -- "$log" >&2
    done
  fi
  if [[ "$BOOTSTRAP_CLEANUP_COMPLETE" -eq 0 ]]; then
    if [[ "$BOOTSTRAP_CLEANUP_UNCERTAIN" -ne 0 ]]; then
      cleanup_status=1
    else
      bootstrap_guest_stop || cleanup_status=1
    fi
    if [[ "$cleanup_status" -eq 0 && -d "$BOOTSTRAP_WORK_ROOT" && ! -L "$BOOTSTRAP_WORK_ROOT" \
      && "$(stat -Lc '%d:%i' "$BOOTSTRAP_WORK_ROOT")" == "$BOOTSTRAP_WORK_IDENTITY" ]]; then
      rm -rf -- "$BOOTSTRAP_WORK_ROOT" || cleanup_status=1
    else
      cleanup_status=1
    fi
  fi
  if [[ "$cleanup_status" -ne 0 ]]; then
    printf 'fresh Ubuntu VM cleanup uncertain; preserved=%s\n' "$BOOTSTRAP_WORK_ROOT" >&2
    status=125
  fi
  printf 'fresh Ubuntu VM evidence: %s\n' "$BOOTSTRAP_EVIDENCE_ROOT"
  exit "$status"
}
trap bootstrap_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bootstrap_source_verify_bundle "$BOOTSTRAP_WORK_ROOT/source.git"
BOOTSTRAP_BASE_IMAGE="$(timeout --signal=TERM --kill-after=15s 1800s bash \
  "$script_dir/../../plugin-vm/scripts/artifact-cache.bash" "$BOOTSTRAP_IMAGE_URL" "$BOOTSTRAP_IMAGE_SHA256")"
printf '%s  %s\n' "$BOOTSTRAP_IMAGE_SHA256" "$BOOTSTRAP_BASE_IMAGE" | sha256sum --check --strict
printf 'image-url=%s\nimage-sha256=%s\nsource-sha=%s\nsource-tree=%s\n' \
  "$BOOTSTRAP_IMAGE_URL" "$BOOTSTRAP_IMAGE_SHA256" "$SOURCE_SHA" "$SOURCE_TREE" \
  >"$BOOTSTRAP_EVIDENCE_ROOT/input.txt"

for role in ordinary control-qemu; do
  bootstrap_guest_start "$role"
  bootstrap_guest_copy_source
  bootstrap_guest_prepare_source
  bootstrap_guest_run_acceptance "$role"
  if ! bootstrap_guest_stop; then
    BOOTSTRAP_CLEANUP_UNCERTAIN=1
    exit 125
  fi
  printf 'PASS fresh-ubuntu role=%s source=%s\n' "$role" "$SOURCE_SHA"
done

if [[ ! -d "$BOOTSTRAP_WORK_ROOT" || -L "$BOOTSTRAP_WORK_ROOT" \
  || "$(stat -Lc '%d:%i' "$BOOTSTRAP_WORK_ROOT")" != "$BOOTSTRAP_WORK_IDENTITY" ]] \
  || ! rm -rf -- "$BOOTSTRAP_WORK_ROOT"; then
  BOOTSTRAP_CLEANUP_UNCERTAIN=1
  exit 125
fi
BOOTSTRAP_CLEANUP_COMPLETE=1
printf '%s\n' fresh-ubuntu-bootstrap-smoke-ok
