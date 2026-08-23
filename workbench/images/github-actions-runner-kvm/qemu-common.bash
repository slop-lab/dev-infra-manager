#!/usr/bin/env bash

dim_runner_require_qemu_host() {
  local command
  for command in qemu-system-x86_64 qemu-img cloud-localds ssh ssh-keygen; do
    command -v "$command" >/dev/null || {
      echo "missing runner dependency: $command (run: bash scripts/install-kvm-verify-deps-ubuntu.bash)" >&2
      return 2
    }
  done
  test -r /dev/kvm && test -w /dev/kvm || {
    echo "/dev/kvm is not accessible on the QEMU host" >&2
    return 2
  }
}

dim_runner_create_seed() {
  local workdir="$1"
  local instance_id="$2"
  local ssh_port="$3"
  local public_key

  ssh-keygen -q -t ed25519 -N '' -f "$workdir/id"
  public_key="$(cat "$workdir/id.pub")"
  printf 'instance-id: %s\nlocal-hostname: dim-actions-runner\n' "$instance_id" >"$workdir/meta-data"
  printf '#cloud-config\nusers:\n  - name: dim\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n      - %s\n' "$public_key" >"$workdir/user-data"
  cloud-localds "$workdir/seed.img" "$workdir/user-data" "$workdir/meta-data"
  DIM_RUNNER_SSH_ARGS=(
    -i "$workdir/id" -p "$ssh_port"
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
    -o LogLevel=ERROR -o ConnectTimeout=2
  )
}

dim_runner_start_qemu() {
  local disk="$1"
  local seed="$2"
  local log="$3"
  local ssh_port="$4"

  qemu-system-x86_64 \
    -enable-kvm -cpu host \
    -m "${DIM_ACTIONS_RUNNER_MEMORY_MB:-12288}" \
    -smp "${DIM_ACTIONS_RUNNER_CPUS:-6}" \
    -nographic \
    -drive "file=$disk,if=virtio" \
    -drive "file=$seed,format=raw,if=virtio" \
    -netdev "user,id=n,hostfwd=tcp:127.0.0.1:${ssh_port}-:22" \
    -device virtio-net-pci,netdev=n \
    >"$log" 2>&1 &
  DIM_RUNNER_QEMU_PID=$!
}

dim_runner_wait_for_ssh() {
  local log="$1"
  local label="$2"

  echo "$label: wait for guest SSH"
  for _ in $(seq 1 120); do
    if ssh "${DIM_RUNNER_SSH_ARGS[@]}" dim@127.0.0.1 true >/dev/null 2>&1; then
      return 0
    fi
    kill -0 "$DIM_RUNNER_QEMU_PID" >/dev/null 2>&1 || {
      echo "QEMU exited before SSH became ready" >&2
      tail -n 30 "$log" >&2
      return 1
    }
    sleep 2
  done
  echo "timed out waiting for guest SSH" >&2
  tail -n 30 "$log" >&2
  return 1
}
