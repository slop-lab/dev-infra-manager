#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/runtime-backends.sh
source "$script_dir/lib/runtime-backends.sh"
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
for cmd in qemu-system-x86_64 qemu-img cloud-localds curl ssh ssh-keygen tar; do command -v "$cmd" >/dev/null || { echo "missing KVM smoke dependency: $cmd (run: just install-kvm-verify-deps-ubuntu)" >&2; exit 2; }; done
test -r /dev/kvm && test -w /dev/kvm || { echo "/dev/kvm is not accessible" >&2; exit 2; }
repo_root="$(cd -- "$script_dir/.." && pwd)"
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
git -C "$repo_root" bundle create "$workdir/repo.bundle" --all
git -C "$repo_root" diff --binary HEAD > "$workdir/working-tree.patch"
git -C "$repo_root" ls-files -z --others --exclude-standard >"$workdir/untracked-files"
tar -C "$repo_root" --null -T "$workdir/untracked-files" -czf "$workdir/untracked-files.tar.gz"
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
cloud-localds "$workdir/seed.img" "$workdir/user-data" "$workdir/meta-data"
qemu-img create -q -f qcow2 -F qcow2 -b "$image" "$workdir/root.qcow2" 24G
qemu-system-x86_64 -enable-kvm -cpu host -m 4096 -smp 4 -nographic -drive "file=$workdir/root.qcow2,if=virtio" -drive "file=$workdir/seed.img,format=raw,if=virtio" -netdev user,id=n,hostfwd=tcp:127.0.0.1:22222-:22 -device virtio-net-pci,netdev=n >"$workdir/qemu.log" 2>&1 & pid=$!
ssh_args=(-i "$workdir/id" -p 22222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=2)
clone_repository() {
  ssh "${ssh_args[@]}" dim@127.0.0.1 "tar -C /tmp -xzf - && git clone /tmp/repo.bundle dim && git -C dim apply /tmp/working-tree.patch && tar -C dim -xzf /tmp/untracked-files.tar.gz" <"$workdir/repo.tar.gz"
}
install_backend() {
  printf 'yes\n' | ssh "${ssh_args[@]}" dim@127.0.0.1 "cd dim && bash scripts/install-host-ubuntu.sh '$backend'"
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
tar -C "$workdir" -czf "$workdir/repo.tar.gz" repo.bundle working-tree.patch untracked-files.tar.gz
run_step "clone repository" clone_repository
run_step "install $backend backend" install_backend
run_step "run $backend workload" ssh "${ssh_args[@]}" dim@127.0.0.1 "set -e; sudo docker info >/dev/null; case '$backend' in all|sysbox) systemctl is-active sysbox; sudo docker run --rm --runtime=sysbox-runc hello-world >/dev/null;; esac; case '$backend' in all|gvisor) runsc --version; sudo docker run --rm --runtime=runsc hello-world >/dev/null;; esac; case '$backend' in rootless-podman) test -c /dev/fuse; command -v newuidmap; command -v newgidmap; cd dim; sudo docker build -t dev-infra-project-workspace-podman:latest images/project-workspace-podman; sudo docker run --rm --runtime=runc --privileged --device /dev/fuse --security-opt seccomp=unconfined --security-opt apparmor=unconfined dev-infra-project-workspace-podman:latest podman run --rm docker.io/library/hello-world;; esac; case '$backend' in all|runc) sudo docker run --rm --runtime=runc hello-world >/dev/null;; esac"
echo "kvm-host-install-smoke-ok: $backend"
