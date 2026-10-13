#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node_installer="$script_dir/lib/install-trusted-qemu-node.bash"
node_executable=/usr/local/lib/dim-qemu-node-24.19.0/bin/node
kvm_device=/dev/kvm
host_architecture="$(dpkg --print-architecture)"
case "$host_architecture" in
  amd64) node_arch=x64 ;;
  *) echo "unsupported KVM host architecture: $host_architecture (requires amd64)" >&2; exit 2 ;;
esac
node_summary="$(/usr/bin/bash "$node_installer" "$node_arch" --describe)"

install_user="${SUDO_USER:-$(id -un)}"
[[ "$install_user" != root ]] || install_user=""
if [[ -n "$install_user" ]]; then
  group_action="add user '$install_user' to the kvm group"
else
  group_action="verify that root can access the kvm device"
fi

cat <<EOF
Ubuntu KVM verification dependency installer
==============================================

This script is a development convenience, not production hardening guidance.
Review and adapt every change before using it on a production host.

It will:
  - apt-get update
  - apt-get install: curl cloud-image-utils openssh-client qemu-system-x86 qemu-utils xz-utils
$node_summary
  - preserve /usr/local/bin/node and refuse any unsafe or foreign existing target
  - $group_action

Type yes to continue; any other input cancels installation.
EOF
read -r -p "> " confirmation
if [[ "$confirmation" != yes ]]; then
  echo "Installation cancelled."
  exit 1
fi

sudo apt-get update
sudo apt-get install -y \
  curl \
  cloud-image-utils \
  openssh-client \
  qemu-system-x86 \
  qemu-utils \
  xz-utils

sudo /usr/bin/bash "$node_installer" "$node_arch"

if ! getent group kvm >/dev/null; then
  sudo groupadd --system kvm
fi
if [[ -n "$install_user" && " $(id -nG "$install_user") " != *" kvm "* ]]; then
  sudo usermod -aG kvm "$install_user"
fi

for command in qemu-system-x86_64 qemu-img cloud-localds ssh; do
  command -v "$command" >/dev/null || {
    echo "KVM verification dependency '$command' is unavailable after installation" >&2
    exit 1
  }
done
if [[ ! -c "$kvm_device" ]]; then
  echo "$kvm_device is not available as a character device; enable host KVM hardware and kernel support" >&2
  exit 1
fi

if [[ -n "$install_user" ]]; then
  if ! sudo -u "$install_user" sg kvm -c "test -r '$kvm_device' -a -w '$kvm_device'"; then
    echo "user '$install_user' cannot access $kvm_device through the kvm group" >&2
    exit 1
  fi
  cat <<EOF
KVM verification dependencies installed. User '$install_user' belongs to the kvm group.

Group membership is permanent, but this script does not alter the current shell.
Log out and back in, or start one refreshed shell with:

  newgrp kvm

Inside that refreshed normal-user shell, run exactly:

  export DIM_QEMU_NODE_EXECUTABLE=$node_executable
  sudo -v
  bash verification/scripts/kvm-host-install-smoke.bash --preflight-only
  just verify environments-kvm
EOF
else
  test -r "$kvm_device" -a -w "$kvm_device"
  cat <<EOF
KVM verification dependencies installed.
Run verification as a normal operator with:

  export DIM_QEMU_NODE_EXECUTABLE=$node_executable
  sudo -v
  bash verification/scripts/kvm-host-install-smoke.bash --preflight-only
  just verify environments-kvm
EOF
fi
