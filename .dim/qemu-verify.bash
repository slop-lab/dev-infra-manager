#!/usr/bin/env bash
set -euo pipefail
backend="sysbox"
verbose=false
probe=false
agent_control=false
for arg in "$@"; do
  case "$arg" in
    "") ;;
    -v|--verbose) verbose=true ;;
    --probe) probe=true ;;
    --agent-control) agent_control=true ;;
    *)
      echo "usage: $0 [-v|--verbose] [--probe | --agent-control]" >&2
      exit 2
      ;;
  esac
done
[[ "$probe" == false || "$agent_control" == false ]] || { echo "--probe and --agent-control are mutually exclusive" >&2; exit 2; }
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
for cmd in qemu-system-x86_64 qemu-img curl ssh ssh-keygen tar; do command -v "$cmd" >/dev/null || { echo "missing KVM smoke dependency: $cmd (run: bash verification/scripts/install-kvm-verify-deps-ubuntu.bash)" >&2; exit 2; }; done
registry_mirror="${DIM_KVM_REGISTRY_MIRROR:-}"
if [[ -n "$registry_mirror" ]]; then
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
test -d "$repo_root/project/.dim" || { echo "DIM_QEMU_SOURCE_ROOT is not an assembled Project worktree" >&2; exit 2; }
cache="${DIM_KVM_IMAGE_CACHE:-$repo_root/.local/kvm}"
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
mkdir -p "$workbench_snapshot"
snapshot_repository() {
  local source="$1" destination="$2"
  mkdir -p "$destination"
  tar -C "$(dirname "$source")" --exclude=.git --exclude=.local --exclude=node_modules \
    -cf - -- "$(basename "$source")" | tar --strip-components=1 -x -C "$destination"
  git -C "$destination" init --initial-branch=main >/dev/null
  git -C "$destination" add -A
  git -C "$destination" -c user.name="DIM Snapshot" -c user.email="snapshot@dim.invalid" \
    commit -m "snapshot $(basename "$source")" >/dev/null
}
snapshot_repository "$repo_root" "$workbench_snapshot"
for component in project core core-development plugin-dns-cloudflare \
  plugin-dns-cloudflare-development plugin-external-urls \
  plugin-external-urls-development verification examples specification; do
  rm -rf "$workbench_snapshot/$component"
  snapshot_repository "$repo_root/$component" "$workbench_snapshot/$component"
done
tar -C "$workdir" -czf "$workdir/workbench.tar.gz" workbench
inputs_root="$workdir/dim-inputs"
mkdir -p "$inputs_root"
while IFS=$'\t' read -r name source; do
  [[ -n "$name" ]] || continue
  mkdir -p "$inputs_root/$name"
  tar -C "$(dirname "$source")" --exclude=.git --exclude=.local --exclude=node_modules \
    -cf - -- "$(basename "$source")" | tar --strip-components=1 -x -C "$inputs_root/$name"
done < <(printf '%s' "${DIM_QEMU_EXTRA_INPUTS_JSON:-[]}" |
  jq -r '.[] | [.name, .path] | @tsv')
tar -C "$workdir" -czf "$workdir/inputs.tar.gz" dim-inputs
pid=""
cleanup() {
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
printf '#cloud-config\nusers:\n  - name: dim\n    uid: 1001\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n      - %s\n' "$key" > "$workdir/user-data"
if [[ -n "$registry_mirror" ]]; then
  cat >>"$workdir/user-data" <<EOF
write_files:
  - path: /etc/docker/daemon.json
    permissions: '0644'
    content: |
      {
        "registry-mirrors": ["$registry_mirror"],
        "insecure-registries": ["${registry_mirror#http://}"]
      }
EOF
fi
if command -v cloud-localds >/dev/null; then
  cloud-localds "$workdir/seed.img" "$workdir/user-data" "$workdir/meta-data"
else
  genisoimage -quiet -output "$workdir/seed.img" -volid cidata -joliet -rock \
    "$workdir/user-data" "$workdir/meta-data"
fi
qemu-img create -q -f qcow2 -F qcow2 -b "$image" "$workdir/root.qcow2" "${DIM_KVM_SMOKE_DISK_SIZE:-32G}"
qemu-system-x86_64 -enable-kvm -cpu host -m "${DIM_KVM_SMOKE_MEMORY_MB:-4096}" -smp 4 -nographic -drive "file=$workdir/root.qcow2,if=virtio" -drive "file=$workdir/seed.img,format=raw,if=virtio" -netdev user,id=n,hostfwd=tcp:127.0.0.1:22222-:22 -device virtio-net-pci,netdev=n >"$workdir/qemu.log" 2>&1 & pid=$!
ssh_args=(-i "$workdir/id" -p 22222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=2)
clone_repository() {
  ssh "${ssh_args[@]}" dim@127.0.0.1 "mkdir -p dim && tar -C dim -xzf -" <"$workdir/workbench.tar.gz"
  ssh "${ssh_args[@]}" dim@127.0.0.1 "sudo mkdir -p /mnt && sudo tar -C /mnt -xzf -" <"$workdir/inputs.tar.gz"
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
    pnpm --filter @slop-lab/dim-controller-proxy run build >/dev/null
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
run_step "verify stored backend" ssh "${ssh_args[@]}" dim@127.0.0.1 \
  "test \"\$(jq -r .workspaceBackend ~/.config/dim/config.json)\" = '$backend'"
if [[ -n "$registry_mirror" ]]; then
  run_step "verify nested guest registry mirror" ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "sudo docker info --format '{{json .RegistryConfig.Mirrors}}' | grep -Fq '$registry_mirror'"
fi
run_step "run Sysbox workload" ssh "${ssh_args[@]}" dim@127.0.0.1 \
  "set -e; sudo docker info >/dev/null; sudo docker compose version >/dev/null; systemctl is-active sysbox; sudo docker run --rm --runtime=sysbox-runc dim-backend-smoke:local true"
if [[ "$agent_control" == true ]]; then
  run_step "verify agent control of protected QEMU process" \
    ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "cd dim/workbench && DIM_DOCKER_REGISTRY_MIRROR='${DIM_DOCKER_REGISTRY_MIRROR:-}' DIM_TEST_REGISTRY_MIRROR_ADDRESS=10.0.2.2 DIM_SELF_EXPECT_AGENT_UID=1001 DIM_SELF_VERIFY_AGENT=1 DIM_SELF_STOP_AFTER_QEMU_PROBE=1 JUST_UNSTABLE=1 just verify self-development"
  exit 0
fi
run_step "verify common full-development contract" \
  ssh "${ssh_args[@]}" dim@127.0.0.1 \
    "cd dim/workbench && DIM_DOCKER_REGISTRY_MIRROR='${DIM_DOCKER_REGISTRY_MIRROR:-}' DIM_TEST_REGISTRY_MIRROR_ADDRESS=10.0.2.2 JUST_UNSTABLE=1 just verify full-development"
  if [[ "${DIM_KVM_SKIP_TRUSTED_WORKSPACE:-0}" != 1 ]]; then
    run_step "verify trusted KVM workspace and Sysbox isolation probe" \
      ssh "${ssh_args[@]}" dim@127.0.0.1 \
      "DIM_DOCKER_REGISTRY_MIRROR='${DIM_DOCKER_REGISTRY_MIRROR:-}' bash -s" <<'EOF'
      set -e
      trusted=dim-kvm-trusted
      agent=dim-kvm-agent
      cleanup() {
        sudo docker rm -f "$trusted" "$agent" >/dev/null 2>&1 || true
      }
      trap cleanup EXIT
      cd dim/workbench
      pnpm --filter @slop-lab/dim-controller-proxy run build
      sudo docker build --quiet -t dev-infra-project-workspace:latest -f core/images/project-workspace/Dockerfile . >/dev/null
      sudo docker run -d --name "$trusted" --runtime=runc --privileged --device=/dev/kvm \
        dev-infra-project-workspace:latest sleep infinity >/dev/null
      for _ in $(seq 1 60); do
        sudo docker exec "$trusted" docker info >/dev/null 2>&1 && break
        sleep 1
      done
      sudo docker exec "$trusted" test -r /dev/kvm
      sudo docker exec "$trusted" test -w /dev/kvm
      ! sudo docker exec "$trusted" docker info --format "{{json .Runtimes}}" | grep -q sysbox-runc
      sudo docker exec -u root "$trusted" apk add --no-cache qemu-system-x86_64 >/dev/null
      status=0
      sudo docker exec -u root "$trusted" timeout 2 qemu-system-x86_64 \
        -machine q35,accel=kvm -cpu host -m 128 -smp 1 -nodefaults -nographic -S || status=$?
      test "$status" -eq 124
      dind_mirror_flags=()
      if [[ -n "${DIM_DOCKER_REGISTRY_MIRROR:-}" ]]; then
        dind_mirror_flags=(
          --add-host host.docker.internal:host-gateway
          docker:29.1.3-dind
          --registry-mirror "$DIM_DOCKER_REGISTRY_MIRROR"
          --insecure-registry "${DIM_DOCKER_REGISTRY_MIRROR#http://}"
        )
      else
        dind_mirror_flags=(docker:29.1.3-dind)
      fi
      sudo docker run -d --name "$agent" --runtime=sysbox-runc "${dind_mirror_flags[@]}" >/dev/null
      for _ in $(seq 1 60); do
        sudo docker exec "$agent" docker info >/dev/null 2>&1 && break
        sleep 1
      done
      if [[ -n "${DIM_DOCKER_REGISTRY_MIRROR:-}" ]]; then
        sudo docker exec "$agent" docker info --format '{{json .RegistryConfig.Mirrors}}' |
          grep -Fq "$DIM_DOCKER_REGISTRY_MIRROR"
      fi
      sudo docker image save dim-backend-smoke:local |
        sudo docker exec -i "$agent" docker image load >/dev/null
      sudo docker exec "$agent" docker run --rm dim-backend-smoke:local true
      test "$(sudo docker inspect -f "{{.HostConfig.Privileged}}" "$agent")" = false
EOF
  fi
  run_step "verify managed CI runner cgroup boundary" \
    ssh "${ssh_args[@]}" dim@127.0.0.1 '
      set -e
      export DIM_STATE_ROOT=/tmp/dim-ci-runner-state
      export DIM_CONFIG_PATH="$DIM_STATE_ROOT/config.json"
      export DIM_CI_RUNNER_CPUS=1.5
      export DIM_CI_RUNNER_MEMORY=1g
      export DIM_CI_RUNNER_PIDS=1024
      project=ci-smoke
      source=/tmp/dim-ci-source
      cleanup() {
        cd ~/dim/workbench
        pnpm run --silent cli -- ci runner delete "$project" primary --yes >/dev/null 2>&1 || true
        pnpm run --silent cli -- project purge "$project" --yes >/dev/null 2>&1 || true
        sudo docker rm -f dim-ci-ci-smoke-primary >/dev/null 2>&1 || true
        sudo rm -rf "$DIM_STATE_ROOT" "$source"
      }
      trap cleanup EXIT
      mkdir -p "$DIM_STATE_ROOT" "$source"
      printf "%s\n" "{\"schemaVersion\":1,\"workspaceBackend\":\"sysbox\"}" >"$DIM_CONFIG_PATH"
      git config --global user.name Smoke
      git config --global user.email smoke@dim.invalid
      cd ~/dim/workbench
      bash examples/features/ci-runner/create-repository.bash "$source/repository" >/dev/null
      cd ~/dim/workbench
      pnpm run --silent cli -- project create "$project" \
        --repos "$source/repository/root/.dim/repos.yml" --yes >/dev/null
      pnpm run --silent cli -- ci runner create "$project" primary sysbox >/dev/null
      container="$(pnpm run --silent cli -- ci runner status "$project" primary --json | jq -r .executor.containerName)"
      test "$(sudo docker inspect --format "{{.HostConfig.Runtime}}" "$container")" = sysbox-runc
      test "$(sudo docker inspect --format "{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.PidsLimit}}" "$container")" \
        = "1500000000|1073741824|1024"
      test "$(sudo docker inspect --format "{{.HostConfig.Privileged}}" "$container")" = false
      ! sudo docker inspect --format "{{json .Mounts}}" "$container" | grep -q /var/run/docker.sock
      for _ in $(seq 1 60); do
        status="$(sudo docker inspect --format "{{.State.Status}}" "$container")"
        [[ "$status" != running ]] || break
        sleep 1
      done
      test "$status" = running
    '
  run_step "verify non-root repository CI workflow" \
    ssh "${ssh_args[@]}" dim@127.0.0.1 \
      "cd dim/workbench && DIM_CI_RUNNER_EXAMPLE_ATTEMPTS=300 bash verification/scripts/ci-runner-example-smoke.bash"
echo "kvm-host-install-smoke-ok: $backend"
