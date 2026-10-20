# Two simultaneously owned QEMU guests. Global bootstrap helpers select one at a time.
declare -A EXAMPLES_VM_PID=() EXAMPLES_VM_START=() EXAMPLES_VM_ROOT=() EXAMPLES_VM_ID=() EXAMPLES_VM_PORT=()
EXAMPLES_CP_SSH_PID=""
EXAMPLES_CP_SSH_START=""
examples_vm_save() {
  local role="$1"
  EXAMPLES_VM_PID[$role]="$BOOTSTRAP_QEMU_PID"; EXAMPLES_VM_START[$role]="$BOOTSTRAP_QEMU_START"
  EXAMPLES_VM_ROOT[$role]="$BOOTSTRAP_GUEST_ROOT"; EXAMPLES_VM_ID[$role]="$BOOTSTRAP_GUEST_IDENTITY"; EXAMPLES_VM_PORT[$role]="$BOOTSTRAP_SSH_PORT"
}
examples_vm_select() {
  local role="$1" port="${EXAMPLES_VM_PORT[$1]}"
  BOOTSTRAP_QEMU_PID="${EXAMPLES_VM_PID[$role]}"; BOOTSTRAP_QEMU_START="${EXAMPLES_VM_START[$role]}"
  BOOTSTRAP_GUEST_ROOT="${EXAMPLES_VM_ROOT[$role]}"; BOOTSTRAP_GUEST_IDENTITY="${EXAMPLES_VM_ID[$role]}"; BOOTSTRAP_SSH_PORT="$port"
  BOOTSTRAP_SSH=(ssh -p "$port" -i "$BOOTSTRAP_GUEST_ROOT/login-key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$BOOTSTRAP_GUEST_ROOT/known_hosts" -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 dim@127.0.0.1)
  BOOTSTRAP_SCP=(scp -P "$port" -i "$BOOTSTRAP_GUEST_ROOT/login-key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$BOOTSTRAP_GUEST_ROOT/known_hosts" -o ConnectTimeout=10)
}
bootstrap_examples_stop_all() {
  local role failed=0
  if declare -F check_output_stop >/dev/null; then check_output_stop; fi
  if [[ -n "$EXAMPLES_CP_SSH_PID" ]]; then
    if [[ -r "/proc/$EXAMPLES_CP_SSH_PID/stat" && "$(cut -d' ' -f22 "/proc/$EXAMPLES_CP_SSH_PID/stat")" == "$EXAMPLES_CP_SSH_START" ]]; then
      kill "$EXAMPLES_CP_SSH_PID" 2>/dev/null || true
    fi
    wait "$EXAMPLES_CP_SSH_PID" 2>/dev/null || true
    EXAMPLES_CP_SSH_PID=""
  fi
  # A partially booted guest may fail before its snapshot was saved.
  if [[ -n "$BOOTSTRAP_QEMU_PID" ]]; then
    local saved=0
    for role in host control-plane; do [[ "${EXAMPLES_VM_PID[$role]:-}" != "$BOOTSTRAP_QEMU_PID" ]] || saved=1; done
    if [[ "$saved" == 0 ]]; then bootstrap_guest_stop || failed=1; fi
  fi
  for role in host control-plane; do
    [[ -n "${EXAMPLES_VM_PID[$role]:-}" ]] || continue
    examples_vm_select "$role"
    if bootstrap_guest_stop; then unset 'EXAMPLES_VM_PID[$role]'; else failed=1; fi
  done
  return "$failed"
}
bootstrap_examples_run() {
  local cp_machine host_machine cp_key_type cp_key
  source "$script_dir/lib/check-output.bash"
  check_output_init "$BOOTSTRAP_EVIDENCE_ROOT/stages"
  printf '[examples] phase=boot-control-plane log=%s/examples-control-plane-console.log\n' "$BOOTSTRAP_EVIDENCE_ROOT"
  bootstrap_guest_start examples-control-plane 3072; examples_vm_save control-plane
  bootstrap_guest_copy_source; bootstrap_guest_prepare_source
  printf '[examples] phase=control-plane-tools log=%s/01-control-plane-tools.log\n' "$CHECK_OUTPUT_ROOT"
  check_output_run control-plane-tools timeout --signal=TERM --kill-after=30s 1800s "${BOOTSTRAP_SSH[@]}" \
    'cd /home/dim/dim/workbench && sudo bash scripts/checks/lib/install-source-tools-ubuntu.bash && ! command -v docker'
  cp_machine="$("${BOOTSTRAP_SSH[@]}" cat /etc/machine-id)"
  printf '[examples] phase=boot-workspace-host log=%s/examples-workspace-host-console.log\n' "$BOOTSTRAP_EVIDENCE_ROOT"
  bootstrap_guest_start examples-workspace-host 4096; examples_vm_save host
  bootstrap_guest_copy_source; bootstrap_guest_prepare_source
  # Keep this shell function outside check_output_run's conditional subshell:
  # Bash otherwise disables errexit inside its multi-step bootstrap body.
  bootstrap_guest_run_acceptance ordinary
  host_machine="$("${BOOTSTRAP_SSH[@]}" cat /etc/machine-id)"
  [[ -n "$cp_machine" && -n "$host_machine" && "$cp_machine" != "$host_machine" ]] || { echo 'CP and host must be different VM identities' >&2; return 1; }
  printf 'control-plane-machine=%s\nworkspace-host-machine=%s\n' "$cp_machine" "$host_machine" >"$BOOTSTRAP_EVIDENCE_ROOT/roles.txt"
  printf '[examples] phase=host-build-images-artifacts log=%s/02-host-build-images-artifacts.log\n' "$CHECK_OUTPUT_ROOT"
  check_output_run host-build-images-artifacts timeout --signal=TERM --kill-after=30s 5400s "${BOOTSTRAP_SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
export PATH=/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin:/usr/local/lib/dim-qemu-node-24.19.0/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd /home/dim/dim/workbench
pnpm install --frozen-lockfile
pnpm run workspace:build
DIM_VERIFY_SKIP_BUILD=1 bash scripts/checks/native-idle-service-images-smoke.bash
just verify installer-artifacts
mkdir -m 0700 /home/dim/dim/example-packages
node scripts/pack-local-packages.ts "$PWD" /home/dim/dim/example-packages
node scripts/examples/prepare-separated.ts /home/dim/dim/example-operator
REMOTE
  mkdir -m 0700 "$BOOTSTRAP_WORK_ROOT/transfer"
  timeout 300s "${BOOTSTRAP_SCP[@]}" -r dim@127.0.0.1:/home/dim/dim/example-packages dim@127.0.0.1:/home/dim/dim/example-operator "$BOOTSTRAP_WORK_ROOT/transfer/"
  # The login key is test-owned, host-private and host-key pinned; it never enters a workspace.
  timeout 60s "${BOOTSTRAP_SCP[@]}" "${EXAMPLES_VM_ROOT[control-plane]}/login-key" dim@127.0.0.1:/home/dim/examples-cp-key
  read -r cp_key_type cp_key _ <"${EXAMPLES_VM_ROOT[control-plane]}/host-key.pub"
  printf 'examples-control-plane %s %s\n' "$cp_key_type" "$cp_key" >"$BOOTSTRAP_WORK_ROOT/transfer/cp-known-hosts"
  timeout 60s "${BOOTSTRAP_SCP[@]}" "$BOOTSTRAP_WORK_ROOT/transfer/cp-known-hosts" dim@127.0.0.1:/home/dim/examples-cp-known-hosts
  examples_vm_select control-plane
  timeout 300s "${BOOTSTRAP_SCP[@]}" -r "$BOOTSTRAP_WORK_ROOT/transfer/example-packages" "$BOOTSTRAP_WORK_ROOT/transfer/example-operator" dim@127.0.0.1:/home/dim/dim/
  printf '[examples] phase=control-plane-install-start log=%s/separate-control-plane.log\n' "$BOOTSTRAP_EVIDENCE_ROOT"
  timeout --signal=TERM --kill-after=30s 7200s "${BOOTSTRAP_SSH[@]}" \
    'export PATH=/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin:/usr/local/lib/dim-qemu-node-24.19.0/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd /home/dim/dim/workbench; export DIM_EXAMPLE_PACKAGE_BUNDLE=/home/dim/dim/example-packages DIM_EXAMPLE_REMOTE_SETUP=/home/dim/dim/example-operator; bash scripts/examples/serve-installed-control-plane.bash' \
    >"$BOOTSTRAP_EVIDENCE_ROOT/separate-control-plane.log" 2>&1 &
  EXAMPLES_CP_SSH_PID=$!
  EXAMPLES_CP_SSH_START="$(cut -d' ' -f22 "/proc/$EXAMPLES_CP_SSH_PID/stat")"
  examples_vm_select host
  printf '[examples] phase=host-installed-recipes log=%s/03-host-installed-recipes.log\n' "$CHECK_OUTPUT_ROOT"
  check_output_run host-installed-recipes timeout --signal=TERM --kill-after=30s 5400s "${BOOTSTRAP_SSH[@]}" bash -s -- "${EXAMPLES_VM_PORT[control-plane]}" <<'REMOTE'
set -euo pipefail
export PATH=/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin:/usr/local/lib/dim-qemu-node-24.19.0/bin:/usr/sbin:/usr/bin:/sbin:/bin
chmod 0600 /home/dim/examples-cp-key /home/dim/examples-cp-known-hosts
ssh -N -p "$1" -i /home/dim/examples-cp-key -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o HostKeyAlias=examples-control-plane -o UserKnownHostsFile=/home/dim/examples-cp-known-hosts -o ExitOnForwardFailure=yes \
  -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
  -L 127.0.0.1:18080:127.0.0.1:8080 -L 127.0.0.1:18081:127.0.0.1:8081 dim@10.0.2.2 &
tunnel=$!
tunnel_start="$(cut -d' ' -f22 "/proc/$tunnel/stat")"
cleanup_tunnel() {
  if [[ -r "/proc/$tunnel/stat" && "$(cut -d' ' -f22 "/proc/$tunnel/stat")" == "$tunnel_start" ]]; then kill "$tunnel" 2>/dev/null || true; fi
  wait "$tunnel" 2>/dev/null || true
  rm -f /home/dim/examples-cp-key /home/dim/examples-cp-known-hosts
}
trap cleanup_tunnel EXIT
# The runtime's plain HTTP transport is loopback-only; pinned SSH carries the inter-VM bytes.
cd /home/dim/dim/workbench
node scripts/examples/wait-separated.ts /home/dim/dim/example-operator
kill -0 "$tunnel"
export DIM_EXAMPLE_PACKAGE_BUNDLE=/home/dim/dim/example-packages DIM_EXAMPLE_REMOTE_SETUP=/home/dim/dim/example-operator
export DIM_EXAMPLE_REMOTE_ENDPOINT=http://127.0.0.1:18080 DIM_EXAMPLE_REMOTE_CI_ENDPOINT=http://127.0.0.1:18081
bash scripts/examples/verify-installed.bash
REMOTE
  printf 'PASS separate control-plane and workspace-host VMs source=%s\n' "$SOURCE_SHA"
}
