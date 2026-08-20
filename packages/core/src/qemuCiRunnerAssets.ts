export const QEMU_CI_SUPERVISOR_IMAGE = "dim-qemu-ci-supervisor:0.1";

export const QEMU_CI_SUPERVISOR_DOCKERFILE = `FROM ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      ca-certificates cloud-image-utils curl openssh-client qemu-system-x86 qemu-utils xz-utils \\
 && rm -rf /var/lib/apt/lists/*
COPY supervise.bash /usr/local/bin/dim-qemu-ci-supervise
ENTRYPOINT ["bash", "/usr/local/bin/dim-qemu-ci-supervise"]
`;

export const QEMU_CI_SUPERVISOR_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

: "\${GITEA_INSTANCE_URL:?GITEA_INSTANCE_URL is required}"
: "\${GITEA_RUNNER_REGISTRATION_TOKEN:?GITEA_RUNNER_REGISTRATION_TOKEN is required}"
: "\${GITEA_RUNNER_NAME:?GITEA_RUNNER_NAME is required}"

data_root=/var/lib/dim-qemu-ci
cache_root="$data_root/cache"
run_root="$data_root/runs"
cloud_image="$cache_root/noble-server-cloudimg-amd64.img"
runner_version=3.2.0
runner_checksum=335d0f12e4fdf2cdc2310e9ce8ad33303d0f6889fe2efa2e1999d2f5614d440f
mkdir -p "$cache_root" "$run_root"

if [[ ! -f "$cloud_image" ]]; then
  echo "qemu-ci: download verified Ubuntu 24.04 cloud image"
  curl -fsSL -o "$cloud_image.tmp" https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
  curl -fsSL -o "$cache_root/SHA256SUMS" https://cloud-images.ubuntu.com/noble/current/SHA256SUMS
  checksum="$(awk '$2 ~ /noble-server-cloudimg-amd64.img$/ { print $1 }' "$cache_root/SHA256SUMS")"
  [[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || { echo "qemu-ci: cloud image checksum is missing" >&2; exit 1; }
  echo "$checksum  $cloud_image.tmp" | sha256sum -c -
  mv "$cloud_image.tmp" "$cloud_image"
fi

cleanup_dir=""
qemu_pid=""
cleanup() {
  if [[ -n "$qemu_pid" ]]; then
    kill "$qemu_pid" >/dev/null 2>&1 || true
    wait "$qemu_pid" >/dev/null 2>&1 || true
  fi
  [[ -z "$cleanup_dir" ]] || rm -rf -- "$cleanup_dir"
}
trap cleanup EXIT INT TERM

while true; do
  cleanup_dir="$(mktemp -d "$run_root/job-XXXXXX")"
  ssh-keygen -q -t ed25519 -N '' -f "$cleanup_dir/id"
  public_key="$(cat "$cleanup_dir/id.pub")"
  cat >"$cleanup_dir/meta-data" <<EOF
instance-id: dim-qemu-ci-$(date +%s%N)
local-hostname: dim-qemu-ci
EOF
  cat >"$cleanup_dir/user-data" <<EOF
#cloud-config
users:
  - name: dim
    uid: 1001
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $public_key
package_update: true
packages:
  - cloud-image-utils
  - curl
  - git
  - jq
  - just
  - openssh-client
  - qemu-system-x86
  - qemu-utils
  - xz-utils
runcmd:
  - [bash, -lc, "curl -fsSL -o /usr/local/bin/gitea-runner.xz https://gitea.com/gitea/runner/releases/download/v$runner_version/gitea-runner-$runner_version-linux-amd64.xz"]
  - [bash, -lc, "echo '$runner_checksum  /usr/local/bin/gitea-runner.xz' | sha256sum -c -"]
  - [bash, -lc, "xz -d /usr/local/bin/gitea-runner.xz && chmod 0755 /usr/local/bin/gitea-runner"]
  - [bash, -lc, "modprobe kvm && { grep -qw vmx /proc/cpuinfo && modprobe kvm_intel || modprobe kvm_amd; } && usermod -aG kvm dim"]
  - [bash, -lc, "install -d -o dim -g dim /var/lib/gitea-runner && touch /run/dim-qemu-ci-ready"]
EOF
  cloud-localds "$cleanup_dir/seed.img" "$cleanup_dir/user-data" "$cleanup_dir/meta-data"
  qemu-img create -q -f qcow2 -F qcow2 -b "$cloud_image" "$cleanup_dir/root.qcow2" "\${DIM_QEMU_CI_DISK_SIZE:-64G}"
  echo "qemu-ci: start disposable runner VM name=$GITEA_RUNNER_NAME"
  qemu-system-x86_64 -enable-kvm -cpu host -m "\${DIM_QEMU_CI_MEMORY_MB:-12288}" -smp "\${DIM_QEMU_CI_CPUS:-6}" \\
    -nographic -no-reboot \\
    -drive "file=$cleanup_dir/root.qcow2,if=virtio" \\
    -drive "file=$cleanup_dir/seed.img,format=raw,if=virtio" \\
    -netdev user,id=n,hostfwd=tcp:127.0.0.1:2222-:22 -device virtio-net-pci,netdev=n &
  qemu_pid=$!
  ssh_args=(-i "$cleanup_dir/id" -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=2)
  ready=false
  for _ in $(seq 1 180); do
    if ssh "\${ssh_args[@]}" dim@127.0.0.1 test -f /run/dim-qemu-ci-ready >/dev/null 2>&1; then
      ready=true
      break
    fi
    kill -0 "$qemu_pid" >/dev/null 2>&1 || break
    sleep 2
  done
  if [[ "$ready" != true ]]; then
    echo "qemu-ci: disposable runner VM did not become ready" >&2
    kill "$qemu_pid" >/dev/null 2>&1 || true
    wait "$qemu_pid" || true
    exit 1
  fi
  echo "qemu-ci: register one-job ephemeral runner"
  printf '%s\\n' "$GITEA_RUNNER_REGISTRATION_TOKEN" | ssh "\${ssh_args[@]}" dim@127.0.0.1 \\
    "read -r token; cd /var/lib/gitea-runner; sudo /usr/local/bin/gitea-runner register --no-interactive --ephemeral --instance '$GITEA_INSTANCE_URL' --token \"\\$token\" --name '$GITEA_RUNNER_NAME' --labels dim-release-gate:host; unset token; sudo /usr/local/bin/gitea-runner daemon; sudo poweroff"
  wait "$qemu_pid" || true
  qemu_pid=""
  echo "qemu-ci: disposable runner VM exited; replace it"
  rm -rf -- "$cleanup_dir"
  cleanup_dir=""
done
`;
