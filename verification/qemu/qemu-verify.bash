#!/usr/bin/env bash
set -euo pipefail
backend="sysbox"
verbose=false
probe=false
cache_routing=false
for arg in "$@"; do
  case "$arg" in
    "") ;;
    -v|--verbose) verbose=true ;;
    --probe) probe=true ;;
    --cache-routing) cache_routing=true ;;
    *)
      echo "usage: $0 [-v|--verbose] [--probe | --cache-routing]" >&2
      exit 2
      ;;
  esac
done
mode_count=0
[[ "$probe" == false ]] || ((mode_count += 1))
[[ "$cache_routing" == false ]] || ((mode_count += 1))
[[ "$mode_count" -le 1 ]] || { echo "--probe and --cache-routing are mutually exclusive" >&2; exit 2; }
if [[ "$probe" == true ]]; then
  [[ "$verbose" == false ]] || { echo "--probe does not accept --verbose" >&2; exit 2; }
  command -v qemu-system-x86_64 >/dev/null || { echo "missing QEMU control probe dependency: qemu-system-x86_64" >&2; exit 2; }
  test -r /dev/kvm && test -w /dev/kvm || { echo "/dev/kvm is not accessible" >&2; exit 2; }
  status=0
  timeout 2 qemu-system-x86_64 \
    -machine q35,accel=kvm -cpu host -m 128 -smp 1 \
    -nodefaults -nographic -S || status=$?
  test "$status" -eq 124
  echo "qemu-control-probe-ok"
  exit 0
fi
registry_mirror="${DIM_KVM_REGISTRY_MIRROR:-}"
cache_routing_ref="${DIM_CACHE_ROUTING_REF:-}"
cache_routing_outage_ref="${DIM_CACHE_ROUTING_OUTAGE_REF:-}"
cache_relay_pid="${DIM_CI_REGISTRY_CACHE_RELAY_PID:-}"
cache_relay_start_time=""
validate_cache_relay() {
  local relay_comm="" relay_parent_pid="" relay_start_time=""
  [[ -r "/proc/$cache_relay_pid/status" && -r "/proc/$cache_relay_pid/comm" && -r "/proc/$cache_relay_pid/stat" ]] || {
    echo "DIM_CI_REGISTRY_CACHE_RELAY_PID does not identify a running process" >&2
    return 1
  }
  while read -r key value _; do
    [[ "$key" != PPid: ]] || relay_parent_pid="$value"
  done < "/proc/$cache_relay_pid/status"
  IFS= read -r relay_comm < "/proc/$cache_relay_pid/comm"
  relay_start_time="$(awk '{ print $22 }' "/proc/$cache_relay_pid/stat" 2>/dev/null)"
  [[ "$relay_parent_pid" == "$PPID" && "$relay_comm" == socat ]] || {
    echo "DIM_CI_REGISTRY_CACHE_RELAY_PID is not the wrapper-owned socat relay" >&2
    return 1
  }
  [[ -n "$relay_start_time" && ( -z "$cache_relay_start_time" || "$relay_start_time" == "$cache_relay_start_time" ) ]] || {
    echo "wrapper-owned socat relay process identity changed" >&2
    return 1
  }
  cache_relay_start_time="$relay_start_time"
}
if [[ "$cache_routing" == true ]]; then
  [[ -n "$registry_mirror" ]] || { echo "DIM_KVM_REGISTRY_MIRROR is required for --cache-routing" >&2; exit 2; }
  [[ -n "$cache_routing_ref" ]] || { echo "DIM_CACHE_ROUTING_REF is required for --cache-routing" >&2; exit 2; }
  [[ -n "$cache_routing_outage_ref" ]] || { echo "DIM_CACHE_ROUTING_OUTAGE_REF is required for --cache-routing" >&2; exit 2; }
  [[ "$cache_relay_pid" =~ ^[1-9][0-9]*$ ]] || { echo "DIM_CI_REGISTRY_CACHE_RELAY_PID must be a positive integer" >&2; exit 2; }
  immutable_ref_pattern='^docker\.io/[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$'
  [[ "$cache_routing_ref" =~ $immutable_ref_pattern ]] || { echo "invalid DIM_CACHE_ROUTING_REF" >&2; exit 2; }
  [[ "$cache_routing_outage_ref" =~ $immutable_ref_pattern ]] || { echo "invalid DIM_CACHE_ROUTING_OUTAGE_REF" >&2; exit 2; }
  [[ "$cache_routing_ref" != "$cache_routing_outage_ref" ]] || { echo "cache-routing refs must be distinct" >&2; exit 2; }
  [[ "$registry_mirror" =~ ^http://([A-Za-z0-9.-]+):([1-9][0-9]*)$ ]] || {
    echo "invalid DIM_KVM_REGISTRY_MIRROR: $registry_mirror" >&2
    exit 2
  }
  validate_cache_relay || exit 2
fi
for cmd in qemu-system-x86_64 qemu-img curl ssh ssh-keygen tar; do command -v "$cmd" >/dev/null || { echo "missing KVM smoke dependency: $cmd (run: bash verification/scripts/install-kvm-verify-deps-ubuntu.bash)" >&2; exit 2; }; done
if [[ "$cache_routing" == false && -n "$registry_mirror" ]]; then
  [[ "$registry_mirror" =~ ^http://([A-Za-z0-9.-]+):([1-9][0-9]*)$ ]] || {
    echo "invalid DIM_KVM_REGISTRY_MIRROR: $registry_mirror" >&2
    exit 2
  }
fi
if ! command -v cloud-localds >/dev/null && ! command -v genisoimage >/dev/null; then
  echo "missing KVM smoke dependency: cloud-localds or genisoimage" >&2
  exit 2
fi
test -r /dev/kvm && test -w /dev/kvm || { echo "/dev/kvm is not accessible" >&2; exit 2; }
repo_root="${DIM_QEMU_SOURCE_ROOT:-/workspace}"
test -d "$repo_root/verification/qemu" || { echo "DIM_QEMU_SOURCE_ROOT is not a DIM source repository" >&2; exit 2; }
cache="${DIM_KVM_IMAGE_CACHE:-$repo_root/.local/kvm}"
guest_cpus="${DIM_KVM_SMOKE_CPUS:-4}"
guest_memory_mb="${DIM_KVM_SMOKE_MEMORY_MB:-4096}"
[[ "$guest_cpus" =~ ^[1-9][0-9]*$ ]] || { echo "DIM_KVM_SMOKE_CPUS must be a positive integer" >&2; exit 2; }
[[ "$guest_memory_mb" =~ ^[1-9][0-9]*$ ]] || { echo "DIM_KVM_SMOKE_MEMORY_MB must be a positive integer" >&2; exit 2; }
mkdir -p "$cache/runs"
workdir="$(mktemp -d "$cache/runs/local.XXXXXX")"
step_log="$workdir/step.log"
run_step() {
  local label="$1"
  shift
  echo "kvm[$backend]: $label ($(date --iso-8601=seconds))"
  if [[ "$verbose" == true ]]; then
    "$@"
  elif ! "$@" 2>&1 | tee "$step_log"; then
    echo "kvm[$backend]: $label failed; last 120 log lines:" >&2
    tail -n 120 "$step_log" >&2
    return 1
  fi
}
workbench_snapshot="$workdir/workbench"
snapshot_repository() {
  local source="$1" destination="$2" source_commit archived_commit
  source_commit="$(/usr/bin/git --no-replace-objects -C "$source" rev-parse --verify 'HEAD^{commit}')"
  mkdir -p "$destination"
  /usr/bin/git --no-replace-objects -C "$source" archive "$source_commit" | tar -x -C "$destination"
  archived_commit="$(/usr/bin/git --no-replace-objects -C "$source" rev-parse --verify 'HEAD^{commit}')"
  test "$archived_commit" = "$source_commit"
  /usr/bin/git -C "$destination" init --initial-branch=main >/dev/null
  /usr/bin/git -C "$destination" add --force -A
  /usr/bin/git -C "$destination" -c user.name="DIM Snapshot" -c user.email="snapshot@dim.invalid" \
    commit -m "snapshot $(basename "$source") at $source_commit" >/dev/null
}
inputs_root="$workdir/dim-inputs"
if [[ "$cache_routing" == false ]]; then
  mkdir -p "$workbench_snapshot"
  snapshot_repository "$repo_root" "$workbench_snapshot"
  tar -C "$workdir" -czf "$workdir/workbench.tar.gz" workbench
  mkdir -p "$inputs_root"
  while IFS=$'\t' read -r name source; do
    [[ -n "$name" ]] || continue
    mkdir -p "$inputs_root/$name"
    tar -C "$(dirname "$source")" --exclude=.git --exclude=.local --exclude=node_modules \
      -cf - -- "$(basename "$source")" | tar --strip-components=1 -x -C "$inputs_root/$name"
  done < <(printf '%s' "${DIM_QEMU_INPUT_SNAPSHOTS_JSON:-[]}" |
    jq -r '.[] | [.name, .path] | @tsv')
  tar -C "$workdir" -czf "$workdir/inputs.tar.gz" dim-inputs
fi
pid=""
cleanup() {
  local status=$?
  if [[ "${DIM_KVM_PRESERVE_ON_FAILURE:-0}" == 1 && "$status" -ne 0 ]]; then
    disown "$pid" >/dev/null 2>&1 || true
    echo "kvm[$backend]: preserving failed guest pid=$pid workdir=$workdir" >&2
    return
  fi
  if [[ -n "$pid" ]]; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT
image="$cache/noble-server-cloudimg-amd64.img"
curl -fsSL -o "$workdir/SHA256SUMS" https://cloud-images.ubuntu.com/noble/current/SHA256SUMS
sum="$(awk '$2 ~ /noble-server-cloudimg-amd64.img$/ {print $1}' "$workdir/SHA256SUMS")"
test -n "$sum"
if [[ ! -f "$image" ]] || ! echo "$sum  $image" | sha256sum -c - >/dev/null 2>&1; then
  curl -fsSL -o "$image.tmp" https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
  echo "$sum  $image.tmp" | sha256sum -c -
  mv "$image.tmp" "$image"
fi
ssh-keygen -q -t ed25519 -N '' -f "$workdir/id"; key="$(cat "$workdir/id.pub")"
printf 'instance-id: dim-kvm-smoke\nlocal-hostname: dim-kvm-smoke\n' > "$workdir/meta-data"
printf '#cloud-config\nusers:\n  - name: dim\n    uid: 1001\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n      - %s\nwrite_files:\n  - path: /etc/environment\n    append: true\n    permissions: '\''0644'\''\n    content: |\n      PS1=\n' "$key" > "$workdir/user-data"
if [[ -n "$registry_mirror" ]]; then
  cat >>"$workdir/user-data" <<EOF
  - path: /etc/docker/daemon.json
    permissions: '0644'
    content: |
      {
        "registry-mirrors": ["$registry_mirror"],
        "insecure-registries": ["${registry_mirror#http://}"]
      }
bootcmd:
  - sed -E -i '/(^|[[:space:]])(registry-1\.docker\.io|auth\.docker\.io)([[:space:]]|$)/d' /etc/hosts
  - sh -c 'printf "127.0.0.1 registry-1.docker.io\n127.0.0.1 auth.docker.io\n" >> /etc/hosts'
runcmd:
  - |
      for attempt in \$(seq 1 600); do
        systemctl cat docker.service >/dev/null 2>&1 && break
        sleep 1
      done
      systemctl restart docker.service
EOF
fi
if command -v cloud-localds >/dev/null; then
  cloud-localds "$workdir/seed.img" "$workdir/user-data" "$workdir/meta-data"
else
  genisoimage -quiet -output "$workdir/seed.img" -volid cidata -joliet -rock \
    "$workdir/user-data" "$workdir/meta-data"
fi
qemu-img create -q -f qcow2 -F qcow2 -b "$image" "$workdir/root.qcow2" "${DIM_KVM_SMOKE_DISK_SIZE:-32G}"
qemu-system-x86_64 -enable-kvm -cpu host -m "$guest_memory_mb" -smp "$guest_cpus" -nographic -drive "file=$workdir/root.qcow2,if=virtio" -drive "file=$workdir/seed.img,format=raw,if=virtio" -netdev user,id=n,hostfwd=tcp:127.0.0.1:22222-:22 -device virtio-net-pci,netdev=n >"$workdir/qemu.log" 2>&1 & pid=$!
ssh_args=(-i "$workdir/id" -p 22222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=2)
clone_repository() {
  ssh "${ssh_args[@]}" dim@127.0.0.1 "mkdir -p dim && tar -C dim -xzf -" <"$workdir/workbench.tar.gz"
  ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "sudo install -d -o dim -g dim -m 0700 /mnt/dim-inputs && tar -C /mnt/dim-inputs --strip-components=1 --no-same-owner -xzf -" \
    <"$workdir/inputs.tar.gz"
}
install_backend() {
  printf 'yes\n' | ssh "${ssh_args[@]}" dim@127.0.0.1 "cd dim/workbench && bash verification/scripts/install-host-ubuntu.bash '$backend'"
}
guest_ready=false
echo "kvm[$backend]: wait for guest SSH"
for _ in $(seq 1 120); do
  if ssh "${ssh_args[@]}" dim@127.0.0.1 true >/dev/null 2>&1; then
    guest_ready=true
    break
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    wait "$pid" >/dev/null 2>&1 || true
    pid=""
    echo "kvm[$backend]: QEMU exited before SSH became ready; last 30 QEMU log lines:" >&2
    tail -n 30 "$workdir/qemu.log" >&2
    exit 1
  fi
  sleep 2
done
if [[ "$guest_ready" == false ]]; then
  echo "kvm[$backend]: timed out waiting for guest SSH; last 30 QEMU log lines:" >&2
  tail -n 30 "$workdir/qemu.log" >&2
  exit 1
fi
if [[ "$cache_routing" == true ]]; then
  run_step "cache-routing install guest Docker" ssh "${ssh_args[@]}" dim@127.0.0.1 '
    set -e
    sudo apt-get update
    sudo apt-get install -y docker.io
    sudo cloud-init status --wait >/dev/null
    for attempt in $(seq 1 60); do
      sudo docker info >/dev/null 2>&1 && exit 0
      sleep 1
    done
    echo "guest Docker readiness timed out" >&2
    exit 1
  '
  echo "cache-routing[cold-pull]: $cache_routing_ref"
  run_step "cache-routing verify client image is absent" ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "if sudo docker image inspect '$cache_routing_ref' >/dev/null 2>&1; then echo 'cache-routing refuses to remove a pre-existing client image' >&2; exit 1; fi"
  run_step "cache-routing cold pull" ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "sudo docker pull '$cache_routing_ref' >/dev/null"
  run_step "cache-routing remove client image" ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "sudo docker image rm '$cache_routing_ref' >/dev/null"
  echo "cache-routing[warm-pull]: $cache_routing_ref"
  run_step "cache-routing warm pull" ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "sudo docker pull '$cache_routing_ref' >/dev/null"

  validate_cache_relay || { echo "cache relay ownership changed before outage verification" >&2; exit 1; }
  echo "cache-routing[relay-stop]: pid=$cache_relay_pid"
  kill "$cache_relay_pid"
  relay_stopped=false
  for _ in $(seq 1 100); do
    if [[ ! -r "/proc/$cache_relay_pid/status" ]]; then
      relay_stopped=true
      break
    fi
    relay_state="$(awk '$1 == "State:" { print $2 }' "/proc/$cache_relay_pid/status" 2>/dev/null)" || {
      relay_stopped=true
      break
    }
    if [[ "$relay_state" == Z ]]; then
      relay_stopped=true
      break
    fi
    sleep 0.1
  done
  [[ "$relay_stopped" == true ]] || { echo "timed out waiting for cache relay to stop" >&2; exit 1; }

  echo "cache-routing[outage-pull]: $cache_routing_outage_ref"
  if outage_output="$(ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "sudo docker pull '$cache_routing_outage_ref'" 2>&1)"; then
    outage_status=0
  else
    outage_status=$?
  fi
  if [[ "$outage_status" -eq 0 ]]; then
    printf '%s\n' "$outage_output" >&2
    echo "cache-routing outage pull unexpectedly succeeded" >&2
    exit 1
  fi
  hub_endpoint_pattern='(^|[^A-Za-z0-9.-])(registry-1\.docker\.io|auth\.docker\.io)([^A-Za-z0-9.-]|$)'
  if [[ "$outage_output" =~ $hub_endpoint_pattern ]]; then
    outage_endpoint="${BASH_REMATCH[2]}"
  else
    printf '%s\n' "$outage_output" >&2
    echo "cache-routing outage did not identify a direct Docker Hub endpoint" >&2
    exit 1
  fi
  loopback_pattern='(^|[^0-9.])127\.0\.0\.1([^0-9.]|$)'
  if [[ ! "$outage_output" =~ $loopback_pattern ]]; then
    printf '%s\n' "$outage_output" >&2
    echo "cache-routing outage did not terminate at loopback" >&2
    exit 1
  fi
  printf '%s\n' "$outage_output"
  echo "cache-routing[outage-contained]: status=$outage_status endpoint=$outage_endpoint address=127.0.0.1"
  echo "kvm-cache-routing-smoke-ok"
  exit 0
fi
run_step "install guest prerequisites" ssh "${ssh_args[@]}" dim@127.0.0.1 \
  "sudo apt-get update && sudo apt-get install -y busybox-static git just${registry_mirror:+ socat}"
if [[ -n "$registry_mirror" ]]; then
  run_step "relay registry cache to nested containers" ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "sudo systemd-run --quiet --unit=dim-registry-cache-relay --property=Restart=always socat TCP-LISTEN:5000,fork,reuseaddr TCP:${registry_mirror#http://}"
fi
run_step "clone repository" clone_repository
run_step "install full-development verification tools" \
  ssh "${ssh_args[@]}" dim@127.0.0.1 '
    set -e
    curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource-setup.bash
    sudo bash /tmp/nodesource-setup.bash >/dev/null
    rm -f /tmp/nodesource-setup.bash
    sudo apt-get install -y nodejs >/dev/null
    sudo npm install --global pnpm@10.13.1 >/dev/null
    cd dim/workbench
    pnpm install --frozen-lockfile >/dev/null
    pnpm run workspace:build >/dev/null
  '
run_step "install $backend backend" install_backend
run_step "build local backend smoke image" ssh "${ssh_args[@]}" dim@127.0.0.1 '
  set -e
  smoke_root=$(mktemp -d)
  trap '\''sudo rm -rf "$smoke_root"'\'' EXIT
  sudo cp /bin/busybox "$smoke_root/busybox"
  sudo tar -C "$smoke_root" -cf - busybox |
    sudo docker import --change '\''ENTRYPOINT ["/busybox"]'\'' - dim-backend-smoke:local >/dev/null
'
if [[ -n "$registry_mirror" ]]; then
  run_step "verify nested guest registry mirror" ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "sudo docker info --format '{{json .RegistryConfig.Mirrors}}' | grep -Fq '$registry_mirror'"
fi
run_step "run Sysbox workload" ssh "${ssh_args[@]}" dim@127.0.0.1 \
  "set -e; sudo docker info >/dev/null; sudo docker compose version >/dev/null; systemctl is-active sysbox; sudo docker run --rm --runtime=sysbox-runc dim-backend-smoke:local true"
run_step "run independent guest verification stages" \
  ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "cd dim/workbench && DIM_DOCKER_REGISTRY_MIRROR='${DIM_DOCKER_REGISTRY_MIRROR:-}' DIM_KVM_SKIP_TRUSTED_WORKSPACE='${DIM_KVM_SKIP_TRUSTED_WORKSPACE:-0}' bash verification/scripts/kvm-guest-verification-smoke.bash"
echo "kvm-host-install-smoke-ok: $backend"
