#!/usr/bin/env bash
set -euo pipefail

mode="${1:-run}"
case "$mode" in
  run|--check) ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=qemu-common.sh
source "$repo_root/images/github-actions-runner-kvm/qemu-common.sh"
base_image="${DIM_ACTIONS_RUNNER_IMAGE:-$repo_root/.local/github-actions-runner-kvm/base.qcow2}"
runner_url="${GITHUB_RUNNER_URL:-https://github.com/slop-lab/dev-infra-manager}"
runner_labels="${GITHUB_RUNNER_LABELS:-sysbox,kvm}"
runner_name="${GITHUB_RUNNER_NAME:-dim-qemu-$(hostname)-$$}"
ssh_port="${DIM_ACTIONS_RUNNER_SSH_PORT:-22223}"
workdir="$(mktemp -d /tmp/dim-actions-runner-run-XXXXXX)"
pid=""

[[ "$runner_url" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "GITHUB_RUNNER_URL must be an https://github.com/OWNER/REPO URL" >&2
  exit 2
}
[[ "$runner_labels" =~ ^[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+)*$ ]] || {
  echo "GITHUB_RUNNER_LABELS contains an invalid label" >&2
  exit 2
}
[[ "$runner_name" =~ ^[A-Za-z0-9_.-]+$ ]] || {
  echo "GITHUB_RUNNER_NAME contains an invalid character" >&2
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

test -f "$base_image" || {
  echo "runner base image not found: $base_image (run: just build-github-runner-kvm)" >&2
  exit 2
}
dim_runner_require_qemu_host

registration_token=""
if [[ "$mode" == run ]]; then
  registration_token="${GITHUB_RUNNER_TOKEN:-}"
  if [[ -z "$registration_token" ]]; then
    command -v gh >/dev/null || {
      echo "set GITHUB_RUNNER_TOKEN or install an authenticated gh CLI" >&2
      exit 2
    }
    repository="${runner_url#https://github.com/}"
    registration_token="$(gh api --method POST "repos/$repository/actions/runners/registration-token" --jq .token)"
  fi
fi

dim_runner_create_seed "$workdir" "dim-actions-runner-$$" "$ssh_port"
qemu-img create -q -f qcow2 -F qcow2 -b "$base_image" "$workdir/root.qcow2" 48G
dim_runner_start_qemu "$workdir/root.qcow2" "$workdir/seed.img" "$workdir/qemu.log" "$ssh_port"
pid="$DIM_RUNNER_QEMU_PID"
dim_runner_wait_for_ssh "$workdir/qemu.log" "actions-runner[$runner_name]"

ssh "${DIM_RUNNER_SSH_ARGS[@]}" dim@127.0.0.1 \
  "grep -Eqw 'vmx|svm' /proc/cpuinfo && test -r /dev/kvm && test -w /dev/kvm"

if [[ "$mode" == --check ]]; then
  echo "actions-runner[$runner_name]: verify Sysbox, runner binary, and nested KVM"
  ssh "${DIM_RUNNER_SSH_ARGS[@]}" dim@127.0.0.1 \
    "set -e; systemctl is-active sysbox; docker run --rm --runtime=sysbox-runc hello-world >/dev/null; \
     /opt/actions-runner/bin/Runner.Listener --version; \
     status=0; sudo timeout 2 qemu-system-x86_64 -machine q35,accel=kvm -cpu host -m 128 -smp 1 -nodefaults -nographic -S || status=\$?; \
     test \"\$status\" -eq 124"
  ssh "${DIM_RUNNER_SSH_ARGS[@]}" dim@127.0.0.1 "sudo poweroff" >/dev/null 2>&1 || true
  wait "$pid" || true
  pid=""
  echo "actions-runner-image-verify-ok"
  exit 0
fi

echo "actions-runner[$runner_name]: register ephemeral labels=$runner_labels"
printf '%s\n' "$registration_token" | ssh "${DIM_RUNNER_SSH_ARGS[@]}" dim@127.0.0.1 \
  "read -r token && cd /opt/actions-runner && ./config.sh --unattended --ephemeral --replace \
    --url '$runner_url' --token \"\$token\" --name '$runner_name' --labels '$runner_labels' --work _work"
unset registration_token

echo "actions-runner[$runner_name]: waiting for one GitHub Actions job"
ssh "${DIM_RUNNER_SSH_ARGS[@]}" dim@127.0.0.1 \
  "cd /opt/actions-runner && ./run.sh"
ssh "${DIM_RUNNER_SSH_ARGS[@]}" dim@127.0.0.1 "sudo poweroff" >/dev/null 2>&1 || true
wait "$pid" || true
pid=""
echo "actions-runner-ok: $runner_name"
