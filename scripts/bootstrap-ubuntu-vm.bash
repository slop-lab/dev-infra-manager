#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
host_installer="$repo_root/verification/scripts/install-host-ubuntu.bash"
tool_installer="$repo_root/verification/scripts/lib/install-source-tools-ubuntu.bash"
kvm_installer="$repo_root/verification/scripts/lib/install-bootstrap-kvm-ubuntu.bash"
facade_installer="$repo_root/scripts/lib/install-candidate-facade.bash"
pins_helper="$repo_root/scripts/lib/bootstrap-ubuntu-pins.bash"
preflight_helper="$repo_root/scripts/lib/bootstrap-host-preflight.bash"
state_helper="$repo_root/scripts/lib/bootstrap-host-state.bash"
os_release=/etc/os-release
kvm_device=/dev/kvm
runtime_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
resume_marker_root="${XDG_STATE_HOME:-$HOME/.local/state}/dim-bootstrap"
docker_daemon_config=/etc/docker/daemon.json
docker_systemd_overrides=/etc/systemd/system/docker.service.d
docker_data_root=/var/lib/docker
containerd_data_root=/var/lib/containerd
expected_version=0.10.0
role=""
source_sha=""
fresh_acknowledged=0
print_plan=0

usage() {
  cat <<'EOF'
Usage:
  bash scripts/bootstrap-ubuntu-vm.bash --role ordinary|control-qemu \
    --source-sha FULL_40_HEX_SHA [--expected-version VERSION] \
    --acknowledge-fresh-vm
  bash scripts/bootstrap-ubuntu-vm.bash --role ordinary|control-qemu --print-plan

Options:
  --role ROLE                 Install the ordinary or control-qemu host role.
  --source-sha SHA            Exact reviewed, clean source commit to build.
  --expected-version VERSION  Required package version (default: 0.10.0).
  --acknowledge-fresh-vm      Confirm this disposable VM has no workloads/state to adopt.
  --print-plan                Print a read-only preview; does not validate the candidate.
  --help                      Show this help without changing the host.

Execution supports Ubuntu 24.04 amd64 only and must run as a normal sudo operator.
It installs pinned Docker CE, Sysbox, Node.js, pnpm, Just, and the reviewed source.
It never creates secrets, native service JSON, worker units, lingering, tags, or releases.
EOF
}

while (($#)); do
  case "$1" in
    --role) [[ $# -ge 2 ]] || { echo "--role requires a value" >&2; exit 2; }; role="$2"; shift 2 ;;
    --source-sha) [[ $# -ge 2 ]] || { echo "--source-sha requires a value" >&2; exit 2; }; source_sha="$2"; shift 2 ;;
    --expected-version) [[ $# -ge 2 ]] || { echo "--expected-version requires a value" >&2; exit 2; }; expected_version="$2"; shift 2 ;;
    --acknowledge-fresh-vm) fresh_acknowledged=1; shift ;;
    --print-plan) print_plan=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown bootstrap argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$role" in ordinary|control-qemu) ;; *) echo "--role must be ordinary or control-qemu" >&2; exit 2 ;; esac

if [[ "$print_plan" -eq 1 ]]; then
  preview_head="$(GIT_NO_REPLACE_OBJECTS=1 git -C "$repo_root" rev-parse --verify HEAD 2>/dev/null || printf unavailable)"
  preview_status=unknown
  if GIT_NO_REPLACE_OBJECTS=1 git -C "$repo_root" status --porcelain=v1 --untracked-files=all >/dev/null 2>&1; then
    preview_status=inspected
  fi
  cat <<EOF
role: $role
platform: Ubuntu 24.04 amd64
source-preview-head: $preview_head
source-preview-status: $preview_status
candidate-validation: not-performed
docker: 29.1.4 CE with containerd image store, Buildx, Compose v2, Sysbox 0.7.0
source-tools: Node.js 24.19.0, pnpm 10.13.1, Just 1.43.1
runtime-services: not-started
secrets-and-native-config: not-created
EOF
  [[ "$role" == control-qemu ]] && echo "KVM acceleration: required; TCG fallback: forbidden"
  exit 0
fi

PATH="$runtime_path"
export PATH
source "$pins_helper"
source "$preflight_helper"
source "$state_helper"
[[ "$(id -u)" != 0 ]] || { echo "run bootstrap as a normal sudo-capable operator, not root" >&2; exit 2; }
[[ "$fresh_acknowledged" -eq 1 ]] || { echo "execution requires --acknowledge-fresh-vm" >&2; exit 2; }
dim_reject_docker_redirects
for override in DIM_CONFIG_PATH DIM_DATA_HOME DIM_PLUGIN_HOME DIM_INSTALL_PREFIX DIM_STATE_ROOT XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME; do
  [[ ! -v "$override" ]] || { echo "bootstrap requires default user paths; unset $override" >&2; exit 2; }
done
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "--source-sha must be exactly 40 lowercase hexadecimal characters" >&2; exit 2; }
[[ "$expected_version" =~ ^0\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] || { echo "invalid --expected-version" >&2; exit 2; }

source "$os_release"
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || { echo "bootstrap supports Ubuntu 24.04 only" >&2; exit 2; }
[[ "$(dpkg --print-architecture)" == amd64 ]] || { echo "bootstrap supports amd64 only" >&2; exit 2; }
resolved_root="$(GIT_NO_REPLACE_OBJECTS=1 git -C "$repo_root" rev-parse --show-toplevel)"
[[ "$resolved_root" == "$repo_root" ]] || { echo "bootstrap must run from its repository root" >&2; exit 2; }
head_sha="$(GIT_NO_REPLACE_OBJECTS=1 git -C "$repo_root" rev-parse --verify HEAD)"
[[ "$head_sha" == "$source_sha" ]] || { echo "checkout HEAD does not match --source-sha" >&2; exit 2; }
[[ -z "$(GIT_NO_REPLACE_OBJECTS=1 git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" ]] || {
  echo "bootstrap requires an exact clean checkout" >&2
  exit 2
}
source_version="$(awk -F'"' '$2=="version" {print $4; exit}' "$repo_root/package.json")"
[[ "$source_version" == "$expected_version" ]] || {
  echo "source version $source_version does not match expected $expected_version" >&2
  exit 2
}
candidate_root="$HOME/.local/lib/dim-candidates/${expected_version}-${source_sha}"
candidate_facade="$HOME/.local/bin/dim"
resume_marker="$resume_marker_root/ubuntu-vm.state"
dim_config_root="${XDG_CONFIG_HOME:-$HOME/.config}/dim"
dim_state_root="${XDG_STATE_HOME:-$HOME/.local/state}/dim"
dim_data_root="${XDG_DATA_HOME:-$HOME/.local/share}/dim"
operator_uid="$(id -u)"
operator="$(id -un)"

if [[ "$role" == control-qemu && ! -c "$kvm_device" ]]; then
  echo "$kvm_device must be a real character device; TCG fallback is forbidden" >&2
  exit 2
fi

dim_open_bootstrap_state

if [[ "$resume" -eq 0 ]]; then
  sudo /usr/bin/bash "$tool_installer"
  env -u SUDO_USER DIM_HOST_INSTALL_ASSUME_YES=1 bash "$host_installer" sysbox docker-ce
  if [[ "$role" == control-qemu ]]; then
    bash "$kvm_installer" "$operator"
  fi
  [[ ! -e "$docker_systemd_overrides" && ! -L "$docker_systemd_overrides" ]] || {
    echo "host installer introduced unsupported Docker systemd overrides" >&2
    exit 2
  }
  provisioned_docker_config_sha256="$(dim_docker_config_identity)" || { echo "host installer produced unsafe Docker daemon configuration" >&2; exit 2; }
  dim_write_marker awaiting-login "$provisioned_docker_config_sha256"
fi

required_groups=(docker)
[[ "$role" == ordinary ]] || required_groups+=(kvm)
current_groups=" $(id -nG) "
for group in "${required_groups[@]}"; do
  if [[ "$current_groups" != *" $group "* ]]; then
    printf 'Group %s was provisioned; log out and back in, then rerun the identical command.\n' "$group" >&2
    exit 3
  fi
done
dim_verify_local_docker_endpoint
dim_verify_host_stack
if [[ "$role" == control-qemu ]]; then
  [[ -r "$kvm_device" && -w "$kvm_device" ]] || { echo "refreshed operator cannot read and write $kvm_device" >&2; exit 2; }
  echo "KVM device access: provisioned; functional acceleration not probed; TCG fallback: forbidden"
fi

export PATH="$dim_source_tools_root/bin:$dim_node_root/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export DIM_SOURCE_ROOT_COMMIT="$source_sha"
cd "$repo_root"
just prepare-local
bundle_version="$(bash "$repo_root/scripts/local-package-version.bash" "$repo_root/.local/dim-packages")"
bundle_digest="${bundle_version#"$expected_version-local-"}"
[[ "$bundle_version" == "$expected_version-local-$bundle_digest" && "$bundle_digest" =~ ^[0-9a-f]{64}$ ]] || { echo "prepared bundle version does not match expected source candidate: $bundle_version" >&2; exit 2; }
just install-local
bash "$facade_installer" "$repo_root/.local/dim-packages" "$bundle_version" "$source_sha"
expected_version_output="DIM CLI $bundle_version (via DIM installer $bundle_version)"
[[ "$("$HOME/.local/bin/dim" --version)" == "$expected_version_output" ]] || { echo "installed DIM facade is not bound to bundle $bundle_version" >&2; exit 1; }
dim_write_marker complete "$(dim_docker_config_identity)"
cat <<EOF
Bootstrap complete for role $role.
Candidate facade: $HOME/.local/bin/dim
Pinned Just: /usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin/just
Pinned pnpm: /usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin/pnpm
No secrets, native service configuration, worker units, or lingering were created.
EOF
