#!/usr/bin/env bash
set -euo pipefail

backend="${1:?backend is required}"
source_repo="${2:?source repository is required}"
selection="${3:-all}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for cmd in qemu-system-x86_64 qemu-img curl ssh ssh-keygen tar git; do
  command -v "$cmd" >/dev/null || {
    echo "missing QEMU example dependency: $cmd" >&2
    exit 2
  }
done
if ! command -v cloud-localds >/dev/null && ! command -v genisoimage >/dev/null; then
  echo "missing QEMU example dependency: cloud-localds or genisoimage" >&2
  exit 2
fi
test -r /dev/kvm -a -w /dev/kvm || {
  echo "/dev/kvm is not accessible" >&2
  exit 2
}

work_dir="$(mktemp -d /tmp/dim-example-qemu.XXXXXX)"
cache="${DIM_KVM_IMAGE_CACHE:-$source_repo/.local/kvm}"
ssh_port="${DIM_EXAMPLE_QEMU_SSH_PORT:-$(node -e '
  const server = require("node:net").createServer();
  server.listen(0, "127.0.0.1", () => {
    console.log(server.address().port);
    server.close();
  });
')}"
pid=""
cleanup() {
  if [[ -n "$pid" ]]; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
  find "$work_dir" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$cache"
image="$cache/noble-server-cloudimg-amd64.img"
if [[ ! -f "$image" ]]; then
  curl -fsSL -o "$image.tmp" \
    https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
  curl -fsSL -o "$work_dir/SHA256SUMS" \
    https://cloud-images.ubuntu.com/noble/current/SHA256SUMS
  sum="$(awk '$2 ~ /noble-server-cloudimg-amd64.img$/ {print $1}' "$work_dir/SHA256SUMS")"
  echo "$sum  $image.tmp" | sha256sum -c -
  mv "$image.tmp" "$image"
fi

git -C "$source_repo" bundle create "$work_dir/repo.bundle" --all
ssh-keygen -q -t ed25519 -N '' -f "$work_dir/id"
key="$(cat "$work_dir/id.pub")"
printf 'instance-id: dim-example\nlocal-hostname: dim-example\n' >"$work_dir/meta-data"
printf '#cloud-config\nusers:\n  - name: dim\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n      - %s\n' \
  "$key" >"$work_dir/user-data"
if command -v cloud-localds >/dev/null; then
  cloud-localds "$work_dir/seed.img" "$work_dir/user-data" "$work_dir/meta-data"
else
  genisoimage -quiet -output "$work_dir/seed.img" -volid cidata -joliet -rock \
    "$work_dir/user-data" "$work_dir/meta-data"
fi
qemu-img create -q -f qcow2 -F qcow2 -b "$image" "$work_dir/root.qcow2" 32G
qemu-system-x86_64 \
  -enable-kvm -cpu host \
  -m "${DIM_EXAMPLE_QEMU_MEMORY_MB:-3072}" \
  -smp "${DIM_EXAMPLE_QEMU_CPUS:-4}" \
  -nographic \
  -drive "file=$work_dir/root.qcow2,if=virtio" \
  -drive "file=$work_dir/seed.img,format=raw,if=virtio" \
  -netdev "user,id=n,hostfwd=tcp:127.0.0.1:${ssh_port}-:22" \
  -device virtio-net-pci,netdev=n \
  >"$work_dir/qemu.log" 2>&1 &
pid=$!

ssh_args=(
  -i "$work_dir/id" -p "$ssh_port"
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR -o ConnectTimeout=2
)
echo "example[$backend]: wait for guest SSH"
for attempt in $(seq 1 120); do
  ssh "${ssh_args[@]}" dim@127.0.0.1 true >/dev/null 2>&1 && break
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    tail -n 40 "$work_dir/qemu.log" >&2
    exit 1
  fi
  [[ "$attempt" -lt 120 ]] || {
    tail -n 40 "$work_dir/qemu.log" >&2
    exit 1
  }
  sleep 2
done

tar -C "$work_dir" -czf "$work_dir/repo.tar.gz" repo.bundle
ssh "${ssh_args[@]}" dim@127.0.0.1 \
  "sudo apt-get update && sudo apt-get install -y git just" >/dev/null
ssh "${ssh_args[@]}" dim@127.0.0.1 \
  "tar -C /tmp -xzf - && git clone /tmp/repo.bundle dim" \
  <"$work_dir/repo.tar.gz" >/dev/null
printf 'yes\n' | ssh "${ssh_args[@]}" dim@127.0.0.1 \
  "cd dim/workbench && bash verification/scripts/install-host-ubuntu.bash '$backend'" >/dev/null
ssh "${ssh_args[@]}" dim@127.0.0.1 '
  set -e
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource-setup.bash
  sudo bash /tmp/nodesource-setup.bash >/dev/null
  sudo apt-get install -y nodejs >/dev/null
  sudo npm install --global pnpm@10.13.1 >/dev/null
  git config --global user.name "DIM Example Verification"
  git config --global user.email "example@dim.invalid"
'

guest_environment="DIM_EXAMPLE_WORKSPACE_BACKEND=$backend DIM_CI_RUNNER_EXAMPLE_ATTEMPTS=300"
echo "example[$backend]: run verification"
ssh "${ssh_args[@]}" dim@127.0.0.1 \
  "cd dim/workbench && JUST_UNSTABLE=1 just install-dependencies && $guest_environment JUST_UNSTABLE=1 just verify example current-installed auto '$selection'"
echo "example-qemu-smoke-ok: $backend/$selection"
