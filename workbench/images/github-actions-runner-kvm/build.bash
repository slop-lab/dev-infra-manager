#!/usr/bin/env bash
set -euo pipefail

runner_version="${ACTIONS_RUNNER_VERSION:-2.336.0}"
runner_sha256="${ACTIONS_RUNNER_SHA256:-04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=qemu-common.bash
source "$repo_root/images/github-actions-runner-kvm/qemu-common.bash"
cache="${DIM_KVM_IMAGE_CACHE:-$repo_root/.local/kvm}"
output="${DIM_ACTIONS_RUNNER_IMAGE:-$repo_root/.local/github-actions-runner-kvm/base.qcow2}"
ssh_port="${DIM_ACTIONS_RUNNER_SSH_PORT:-22223}"
workdir="$(mktemp -d /tmp/dim-actions-runner-build-XXXXXX)"
pid=""

[[ "$runner_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "invalid ACTIONS_RUNNER_VERSION: $runner_version" >&2
  exit 2
}
[[ "$runner_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "ACTIONS_RUNNER_SHA256 must be 64 lowercase hexadecimal characters" >&2
  exit 2
}
[[ "$ssh_port" =~ ^[0-9]+$ ]] || {
  echo "DIM_ACTIONS_RUNNER_SSH_PORT must be numeric" >&2
  exit 2
}

cleanup() {
  if [[ -n "$pid" ]]; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

dim_runner_require_qemu_host
for command in curl tar; do
  command -v "$command" >/dev/null || { echo "missing runner image dependency: $command" >&2; exit 2; }
done

mkdir -p "$cache" "$(dirname -- "$output")"
cloud_image="$cache/noble-server-cloudimg-amd64.img"
if [[ ! -f "$cloud_image" ]]; then
  curl -fsSL -o "$cloud_image.tmp" \
    https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
  curl -fsSL -o "$workdir/SHA256SUMS" \
    https://cloud-images.ubuntu.com/noble/current/SHA256SUMS
  checksum="$(awk '$2 ~ /noble-server-cloudimg-amd64.img$/ {print $1}' "$workdir/SHA256SUMS")"
  echo "$checksum  $cloud_image.tmp" | sha256sum -c -
  mv "$cloud_image.tmp" "$cloud_image"
fi

dim_runner_create_seed "$workdir" dim-actions-runner-build "$ssh_port"
qemu-img create -q -f qcow2 -F qcow2 -b "$cloud_image" "$workdir/root.qcow2" 64G
dim_runner_start_qemu "$workdir/root.qcow2" "$workdir/seed.img" "$workdir/qemu.log" "$ssh_port"
pid="$DIM_RUNNER_QEMU_PID"
dim_runner_wait_for_ssh "$workdir/qemu.log" actions-runner-image

tar -C "$repo_root" -czf "$workdir/source.tar.gz" \
  images/github-actions-runner-kvm/provision.bash \
  scripts

echo "actions-runner-image: provision Sysbox, nested KVM, and runner ${runner_version}"
ssh "${DIM_RUNNER_SSH_ARGS[@]}" dim@127.0.0.1 \
  "source_root=\$(mktemp -d /tmp/dim-runner-source-XXXXXX)
   trap 'rm -rf -- \"\$source_root\"' EXIT
   tar -C \"\$source_root\" -xzf -
   bash \"\$source_root/images/github-actions-runner-kvm/provision.bash\" \
     '$runner_version' '$runner_sha256' \"\$source_root\"" \
  <"$workdir/source.tar.gz"

ssh "${DIM_RUNNER_SSH_ARGS[@]}" dim@127.0.0.1 "sudo poweroff" >/dev/null 2>&1 || true
wait "$pid" || true
pid=""
rm -f -- "$output.tmp"
qemu-img convert -p -O qcow2 "$workdir/root.qcow2" "$output.tmp"
mv "$output.tmp" "$output"
echo "actions-runner-image-ok: $output"
