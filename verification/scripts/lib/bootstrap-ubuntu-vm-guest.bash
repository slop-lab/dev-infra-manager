BOOTSTRAP_QEMU_PID=""
BOOTSTRAP_QEMU_START=""
BOOTSTRAP_GUEST_ROOT=""
BOOTSTRAP_GUEST_IDENTITY=""

bootstrap_guest_allocate_port() {
  python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

bootstrap_guest_write_cloud_init() {
  local root="$1" role="$2" login_public host_public private_line
  login_public="$(<"$root/login-key.pub")"
  host_public="$(<"$root/host-key.pub")"
  cat >"$root/meta-data" <<EOF
instance-id: dim-bootstrap-$role
local-hostname: dim-bootstrap-$role
EOF
  cat >"$root/user-data" <<EOF
#cloud-config
ssh_deletekeys: false
users:
  - name: dim
    uid: 1001
    groups: [sudo]
    shell: /bin/bash
    lock_passwd: true
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - $login_public
write_files:
  - path: /etc/environment
    append: true
    permissions: '0644'
    content: |
      PS1=
  - path: /etc/ssh/ssh_host_ed25519_key
    owner: root:root
    permissions: '0600'
    content: |
EOF
  while IFS= read -r private_line; do printf '      %s\n' "$private_line"; done \
    <"$root/host-key" >>"$root/user-data"
  cat >>"$root/user-data" <<EOF
  - path: /etc/ssh/ssh_host_ed25519_key.pub
    owner: root:root
    permissions: '0644'
    content: $host_public
package_update: true
packages: [git]
runcmd:
  - [systemctl, restart, ssh]
EOF
}

bootstrap_guest_start() {
  local role="$1" memory_mb=2048 port host_type host_key host_rest
  BOOTSTRAP_GUEST_ROOT="$BOOTSTRAP_WORK_ROOT/$role"
  mkdir -m 0700 "$BOOTSTRAP_GUEST_ROOT"
  BOOTSTRAP_GUEST_IDENTITY="$(stat -Lc '%d:%i' "$BOOTSTRAP_GUEST_ROOT")"
  [[ "$role" == ordinary ]] || memory_mb=3072
  ssh-keygen -q -t ed25519 -N '' -f "$BOOTSTRAP_GUEST_ROOT/login-key"
  ssh-keygen -q -t ed25519 -N '' -f "$BOOTSTRAP_GUEST_ROOT/host-key"
  bootstrap_guest_write_cloud_init "$BOOTSTRAP_GUEST_ROOT" "$role"
  cloud-localds "$BOOTSTRAP_GUEST_ROOT/seed.img" \
    "$BOOTSTRAP_GUEST_ROOT/user-data" "$BOOTSTRAP_GUEST_ROOT/meta-data"
  qemu-img create -q -f qcow2 -F qcow2 -b "$BOOTSTRAP_BASE_IMAGE" \
    "$BOOTSTRAP_GUEST_ROOT/root.qcow2" 32G
  port="$(bootstrap_guest_allocate_port)"
  read -r host_type host_key host_rest <"$BOOTSTRAP_GUEST_ROOT/host-key.pub"
  printf '[127.0.0.1]:%s %s %s\n' "$port" "$host_type" "$host_key" \
    >"$BOOTSTRAP_GUEST_ROOT/known_hosts"
  chmod 0600 "$BOOTSTRAP_GUEST_ROOT/known_hosts"
  BOOTSTRAP_SSH=(ssh -p "$port" -i "$BOOTSTRAP_GUEST_ROOT/login-key"
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$BOOTSTRAP_GUEST_ROOT/known_hosts"
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 dim@127.0.0.1)
  BOOTSTRAP_SCP=(scp -P "$port" -i "$BOOTSTRAP_GUEST_ROOT/login-key"
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$BOOTSTRAP_GUEST_ROOT/known_hosts" -o ConnectTimeout=10)
  qemu-system-x86_64 -machine q35,accel=kvm -cpu host -smp 2 -m "$memory_mb" \
    -nodefaults -no-reboot -display none \
    -serial "file:$BOOTSTRAP_EVIDENCE_ROOT/$role-console.log" \
    -drive "file=$BOOTSTRAP_GUEST_ROOT/root.qcow2,format=qcow2,if=virtio" \
    -drive "file=$BOOTSTRAP_GUEST_ROOT/seed.img,format=raw,if=virtio,readonly=on" \
    -device virtio-rng-pci -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$port-:22" \
    -device virtio-net-pci,netdev=net0 &
  BOOTSTRAP_QEMU_PID=$!
  BOOTSTRAP_QEMU_START="$(cut -d' ' -f22 "/proc/$BOOTSTRAP_QEMU_PID/stat")"
  bootstrap_guest_wait_for_ssh
}

bootstrap_guest_wait_for_ssh() {
  local deadline=$((SECONDS + 900))
  while ((SECONDS < deadline)); do
    if timeout 15s "${BOOTSTRAP_SSH[@]}" cloud-init status --wait >/dev/null 2>&1; then return; fi
    kill -0 "$BOOTSTRAP_QEMU_PID" 2>/dev/null || {
      printf '%s\n' 'QEMU exited before cloud-init and SSH became ready' >&2
      return 1
    }
    sleep 5
  done
  printf '%s\n' 'timed out waiting for cloud-init and verified SSH' >&2
  return 1
}

bootstrap_guest_stop() {
  local current_start state attempt
  [[ -n "$BOOTSTRAP_QEMU_PID" ]] || return 0
  if [[ -e "/proc/$BOOTSTRAP_QEMU_PID/stat" ]]; then
    current_start="$(cut -d' ' -f22 "/proc/$BOOTSTRAP_QEMU_PID/stat")"
    [[ "$current_start" == "$BOOTSTRAP_QEMU_START" ]] || return 1
    state="$(cut -d' ' -f3 "/proc/$BOOTSTRAP_QEMU_PID/stat")"
    if [[ "$state" != Z ]]; then
      tr '\0' ' ' <"/proc/$BOOTSTRAP_QEMU_PID/cmdline" | grep -F -- "$BOOTSTRAP_GUEST_ROOT/root.qcow2" >/dev/null || return 1
      kill -TERM "$BOOTSTRAP_QEMU_PID" || return 1
    fi
    for ((attempt = 0; attempt < 300; attempt += 1)); do
      [[ -e "/proc/$BOOTSTRAP_QEMU_PID/stat" ]] || break
      state="$(cut -d' ' -f3 "/proc/$BOOTSTRAP_QEMU_PID/stat")"
      [[ "$state" == Z ]] && break
      sleep 0.1
    done
    if [[ -e "/proc/$BOOTSTRAP_QEMU_PID/stat" && "$(cut -d' ' -f3 "/proc/$BOOTSTRAP_QEMU_PID/stat")" != Z ]]; then
      kill -KILL "$BOOTSTRAP_QEMU_PID" || return 1
      for ((attempt = 0; attempt < 100; attempt += 1)); do
        [[ ! -e "/proc/$BOOTSTRAP_QEMU_PID/stat" || "$(cut -d' ' -f3 "/proc/$BOOTSTRAP_QEMU_PID/stat")" == Z ]] && break
        sleep 0.1
      done
      [[ ! -e "/proc/$BOOTSTRAP_QEMU_PID/stat" || "$(cut -d' ' -f3 "/proc/$BOOTSTRAP_QEMU_PID/stat")" == Z ]] || return 1
    fi
  fi
  wait "$BOOTSTRAP_QEMU_PID" 2>/dev/null || true
  BOOTSTRAP_QEMU_PID=""
  [[ -d "$BOOTSTRAP_GUEST_ROOT" && ! -L "$BOOTSTRAP_GUEST_ROOT" \
    && "$(stat -Lc '%d:%i' "$BOOTSTRAP_GUEST_ROOT")" == "$BOOTSTRAP_GUEST_IDENTITY" ]] || return 1
  rm -rf -- "$BOOTSTRAP_GUEST_ROOT"
  BOOTSTRAP_GUEST_ROOT=""
}

bootstrap_guest_copy_source() {
  timeout --signal=TERM --kill-after=15s 300s "${BOOTSTRAP_SCP[@]}" \
    "$SOURCE_BUNDLE" dim@127.0.0.1:/home/dim/root.bundle
}

bootstrap_guest_prepare_source() {
  timeout --signal=TERM --kill-after=15s 300s "${BOOTSTRAP_SSH[@]}" \
    bash -s -- "$SOURCE_SHA" "$SOURCE_TREE" <<'REMOTE'
set -euo pipefail
source_sha="$1"; source_tree="$2"
mkdir -p /home/dim/dim
git clone --quiet /home/dim/root.bundle /home/dim/dim/workbench
git -C /home/dim/dim/workbench checkout --quiet --detach "$source_sha"
[[ "$(git -C /home/dim/dim/workbench rev-parse HEAD)" == "$source_sha" ]]
[[ "$(git -C /home/dim/dim/workbench rev-parse 'HEAD^{tree}')" == "$source_tree" ]]
[[ -z "$(git -C /home/dim/dim/workbench status --porcelain=v1 --untracked-files=all)" ]]
rm -f /home/dim/root.bundle
REMOTE
}

bootstrap_guest_run_acceptance() {
  local role="$1" status
  printf 'fresh-ubuntu phase=bootstrap-pass1 role=%s source=%s\n' "$role" "$SOURCE_SHA"
  set +e
  timeout --signal=TERM --kill-after=30s 5400s "${BOOTSTRAP_SSH[@]}" \
    bash -s -- "$SOURCE_SHA" "$role" >"$BOOTSTRAP_EVIDENCE_ROOT/$role-bootstrap-pass1.log" 2>&1 <<'REMOTE'
set -euo pipefail
cd /home/dim/dim/workbench
bash scripts/bootstrap-ubuntu-vm.bash --role "$2" --source-sha "$1" \
  --expected-version 0.10.0 --acknowledge-fresh-vm
REMOTE
  status=$?
  set -e
  [[ "$status" -eq 3 ]] || {
    printf 'first bootstrap login must exit 3; role=%s status=%s\n' "$role" "$status" >&2
    return 1
  }
  printf 'fresh-ubuntu phase=bootstrap-pass2 role=%s source=%s\n' "$role" "$SOURCE_SHA"
  timeout --signal=TERM --kill-after=30s 5400s "${BOOTSTRAP_SSH[@]}" \
    bash -s -- "$SOURCE_SHA" "$role" >"$BOOTSTRAP_EVIDENCE_ROOT/$role-bootstrap-pass2.log" 2>&1 <<'REMOTE'
set -euo pipefail
cd /home/dim/dim/workbench
bash scripts/bootstrap-ubuntu-vm.bash --role "$2" --source-sha "$1" \
  --expected-version 0.10.0 --acknowledge-fresh-vm
version="$($HOME/.local/bin/dim --version)"
[[ "$version" =~ ^DIM\ CLI\ 0\.10\.0-local-[0-9a-f]{64}\ \(via\ DIM\ installer\ 0\.10\.0-local-[0-9a-f]{64}\)$ ]]
docker info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"'
docker run --rm --runtime=sysbox-runc \
  alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412 true
REMOTE
  if [[ "$role" == control-qemu ]]; then
    printf 'fresh-ubuntu phase=control-plane-install role=%s source=%s\n' "$role" "$SOURCE_SHA"
    timeout --signal=TERM --kill-after=30s 5400s "${BOOTSTRAP_SSH[@]}" \
      'export PATH=/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin:/usr/local/lib/dim-qemu-node-24.19.0/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd /home/dim/dim/workbench && pnpm install --frozen-lockfile && just verify control-plane-install-live' \
      >"$BOOTSTRAP_EVIDENCE_ROOT/control-qemu-control-plane-install.log" 2>&1
    printf 'PASS fresh-ubuntu control-plane-install source=%s\n' "$SOURCE_SHA"
    printf 'fresh-ubuntu phase=native-basic-lifecycle role=%s source=%s\n' "$role" "$SOURCE_SHA"
    timeout --signal=TERM --kill-after=30s 5400s "${BOOTSTRAP_SSH[@]}" \
      'export PATH=/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin:/usr/local/lib/dim-qemu-node-24.19.0/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd /home/dim/dim/workbench && just verify native-basic-lifecycle' \
      >"$BOOTSTRAP_EVIDENCE_ROOT/control-qemu-native-basic-lifecycle.log" 2>&1
    printf 'PASS fresh-ubuntu native-basic-lifecycle source=%s\n' "$SOURCE_SHA"
  fi
}
