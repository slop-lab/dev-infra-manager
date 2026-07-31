#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/runtime-backends.bash
source "$script_dir/lib/runtime-backends.bash"
# shellcheck source=lib/git-clone-source.bash
source "$script_dir/lib/git-clone-source.bash"
backend="all"
verbose=false
for arg in "$@"; do
  case "$arg" in
    "") ;;
    -v|--verbose) verbose=true ;;
    all) backend="$arg" ;;
    *)
      if dim_is_runtime_backend "$arg"; then
        backend="$arg"
      else
        echo "usage: $0 [all|$(dim_runtime_backend_choices)] [-v|--verbose]" >&2
        exit 2
      fi
      ;;
  esac
done
if [[ "$backend" == all ]]; then
  verbose_arg=()
  [[ "$verbose" == false ]] || verbose_arg=(--verbose)
  for selected in "${DIM_RUNTIME_BACKENDS[@]}"; do bash "$0" "$selected" "${verbose_arg[@]}"; done
  echo "kvm-host-install-smoke-ok: all"
  exit 0
fi
for cmd in qemu-system-x86_64 qemu-img curl ssh ssh-keygen tar; do command -v "$cmd" >/dev/null || { echo "missing KVM smoke dependency: $cmd (run: just install-kvm-verify-deps-ubuntu)" >&2; exit 2; }; done
if ! command -v cloud-localds >/dev/null && ! command -v genisoimage >/dev/null; then
  echo "missing KVM smoke dependency: cloud-localds or genisoimage" >&2
  exit 2
fi
test -r /dev/kvm && test -w /dev/kvm || { echo "/dev/kvm is not accessible" >&2; exit 2; }
repo_root="$(cd -- "$script_dir/.." && pwd)"
if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
  echo "warning: working tree changes are excluded; KVM verification uses committed HEAD $(git -C "$repo_root" rev-parse --short HEAD)" >&2
  echo "warning: commit the changes before running this verification if they should be included" >&2
fi
workdir="$(mktemp -d /tmp/dim-kvm-install-XXXXXX)"; cache="${DIM_KVM_IMAGE_CACHE:-$repo_root/.local/kvm}"; mkdir -p "$cache"
step_log="$workdir/step.log"
run_step() {
  local label="$1"
  shift
  echo "kvm[$backend]: $label"
  if [[ "$verbose" == true ]]; then
    "$@"
  elif ! "$@" >"$step_log" 2>&1; then
    echo "kvm[$backend]: $label failed; last 30 log lines:" >&2
    tail -n 30 "$step_log" >&2
    return 1
  fi
}
dim_prepare_clone_source "$repo_root" "$workdir/snapshot"
clone_source="$DIM_GIT_CLONE_SOURCE"
git -C "$clone_source" bundle create "$workdir/repo.bundle" --all
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
if [[ ! -f "$image" ]]; then
  curl -fsSL -o "$image.tmp" https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
  curl -fsSL -o "$workdir/SHA256SUMS" https://cloud-images.ubuntu.com/noble/current/SHA256SUMS
  sum="$(awk '$2 ~ /noble-server-cloudimg-amd64.img$/ {print $1}' "$workdir/SHA256SUMS")"; echo "$sum  $image.tmp" | sha256sum -c -; mv "$image.tmp" "$image"
fi
ssh-keygen -q -t ed25519 -N '' -f "$workdir/id"; key="$(cat "$workdir/id.pub")"
printf 'instance-id: dim-kvm-smoke\nlocal-hostname: dim-kvm-smoke\n' > "$workdir/meta-data"
printf '#cloud-config\nusers:\n  - name: dim\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n      - %s\n' "$key" > "$workdir/user-data"
if command -v cloud-localds >/dev/null; then
  cloud-localds "$workdir/seed.img" "$workdir/user-data" "$workdir/meta-data"
else
  genisoimage -quiet -output "$workdir/seed.img" -volid cidata -joliet -rock \
    "$workdir/user-data" "$workdir/meta-data"
fi
qemu-img create -q -f qcow2 -F qcow2 -b "$image" "$workdir/root.qcow2" 24G
qemu-system-x86_64 -enable-kvm -cpu host -m "${DIM_KVM_SMOKE_MEMORY_MB:-4096}" -smp 4 -nographic -drive "file=$workdir/root.qcow2,if=virtio" -drive "file=$workdir/seed.img,format=raw,if=virtio" -netdev user,id=n,hostfwd=tcp:127.0.0.1:22222-:22 -device virtio-net-pci,netdev=n >"$workdir/qemu.log" 2>&1 & pid=$!
ssh_args=(-i "$workdir/id" -p 22222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=2)
clone_repository() {
  ssh "${ssh_args[@]}" dim@127.0.0.1 "tar -C /tmp -xzf - && git clone /tmp/repo.bundle dim" <"$workdir/repo.tar.gz"
}
install_backend() {
  printf 'yes\n' | ssh "${ssh_args[@]}" dim@127.0.0.1 "cd dim && bash scripts/install-host-ubuntu.bash '$backend'"
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
run_step "install guest prerequisites" ssh "${ssh_args[@]}" dim@127.0.0.1 "sudo apt-get update && sudo apt-get install -y git"
tar -C "$workdir" -czf "$workdir/repo.tar.gz" repo.bundle
run_step "clone repository" clone_repository
run_step "install $backend backend" install_backend
run_step "verify stored backend" ssh "${ssh_args[@]}" dim@127.0.0.1 \
  "test \"\$(jq -r .workspaceBackend ~/.config/dim/config.json)\" = '$backend'"
# Rootless Podman's workload runs the outer container with the exact
# capability set workspaceRuntimePlan() grants (packages/core/src/runtimeBackends.ts)
# instead of --privileged, so this is the real verification that those
# specific capabilities are sufficient for nested unprivileged user
# namespaces -- something a doubly-nested dev sandbox cannot exercise.
rootless_podman_caps=(SYS_ADMIN SETUID SETGID SYS_CHROOT SYS_PTRACE AUDIT_WRITE CHOWN DAC_OVERRIDE FOWNER FSETID KILL MKNOD NET_ADMIN NET_BIND_SERVICE NET_RAW SETFCAP SETPCAP)
rootless_podman_cap_flags=""
for cap in "${rootless_podman_caps[@]}"; do rootless_podman_cap_flags+=" --cap-add $cap"; done
run_step "run $backend workload" ssh "${ssh_args[@]}" dim@127.0.0.1 "set -e; sudo docker info >/dev/null; sudo docker compose version >/dev/null; case '$backend' in all|sysbox) systemctl is-active sysbox; sudo docker run --rm --runtime=sysbox-runc hello-world >/dev/null;; esac; case '$backend' in all|gvisor) runsc --version; sudo docker run --rm --runtime=runsc hello-world >/dev/null;; esac; case '$backend' in rootless-podman) test -c /dev/fuse; command -v newuidmap; command -v newgidmap; cd dim; sudo docker build -t dev-infra-project-workspace-podman:latest images/project-workspace-podman; sudo docker run --rm --runtime=runc$rootless_podman_cap_flags --device /dev/fuse --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined dev-infra-project-workspace-podman:latest podman run --rm docker.io/library/hello-world;; esac; case '$backend' in all|runc) sudo docker run --rm --runtime=runc hello-world >/dev/null;; esac"
if [[ "$backend" == sysbox ]]; then
  run_step "install trusted-workspace build tools" \
    ssh "${ssh_args[@]}" dim@127.0.0.1 '
      set -e
      curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource-setup.bash
      sudo bash /tmp/nodesource-setup.bash >/dev/null
      rm -f /tmp/nodesource-setup.bash
      sudo apt-get install -y nodejs >/dev/null
      sudo npm install --global pnpm@10.13.1 >/dev/null
      cd dim
      pnpm install --frozen-lockfile >/dev/null
    '
  if [[ "${DIM_KVM_SKIP_TRUSTED_WORKSPACE:-0}" != 1 ]]; then
    run_step "verify trusted KVM workspace and host-side Sysbox agent" \
      ssh "${ssh_args[@]}" dim@127.0.0.1 '
      set -e
      trusted=dim-kvm-trusted
      agent=dim-kvm-agent
      cleanup() {
        sudo docker rm -f "$trusted" "$agent" >/dev/null 2>&1 || true
      }
      trap cleanup EXIT
      cd dim
      pnpm --filter @slop-lab/dim-controller-proxy run build
      sudo docker build --quiet -t dev-infra-project-workspace:latest -f images/project-workspace/Dockerfile . >/dev/null
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
      sudo docker run -d --name "$agent" --runtime=sysbox-runc docker:29.1.3-dind >/dev/null
      for _ in $(seq 1 60); do
        sudo docker exec "$agent" docker info >/dev/null 2>&1 && break
        sleep 1
      done
      sudo docker exec "$agent" docker run --rm hello-world >/dev/null
      test "$(sudo docker inspect -f "{{.HostConfig.Privileged}}" "$agent")" = false
      '
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
        cd ~/dim
        pnpm run --silent cli -- ci runner disable "$project" --yes >/dev/null 2>&1 || true
        pnpm run --silent cli -- project purge "$project" --yes >/dev/null 2>&1 || true
        sudo docker rm -f dim-ci-ci-smoke >/dev/null 2>&1 || true
        sudo rm -rf "$DIM_STATE_ROOT" "$source"
      }
      trap cleanup EXIT
      mkdir -p "$DIM_STATE_ROOT" "$source"
      printf "%s\n" "{\"schemaVersion\":1,\"workspaceBackend\":\"sysbox\"}" >"$DIM_CONFIG_PATH"
      git init --initial-branch=main "$source/work" >/dev/null
      git -C "$source/work" config user.name Smoke
      git -C "$source/work" config user.email smoke@dim.invalid
      touch "$source/work/README.md"
      git -C "$source/work" add README.md
      git -C "$source/work" commit -m initial >/dev/null
      git clone --bare "$source/work" "$source/project.git" >/dev/null
      cd ~/dim
      pnpm run --silent cli -- project create "$project" >/dev/null
      pnpm run --silent cli -- repo add "$project" root "$source/project.git" \
        --root --ref main >/dev/null
      pnpm run --silent cli -- ci runner enable "$project" >/dev/null
      container="$(pnpm run --silent cli -- ci runner status "$project" --json | jq -r .containerName)"
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
fi
echo "kvm-host-install-smoke-ok: $backend"
