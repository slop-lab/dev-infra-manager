#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node_installer="$script_dir/install-trusted-qemu-node.bash"
install_user="${1:-}"
kvm_device=/dev/kvm

[[ "$install_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "KVM installer requires a normal operator name" >&2; exit 2; }
[[ -c "$kvm_device" ]] || { echo "$kvm_device is not a character device; real KVM is required and TCG is unsupported" >&2; exit 2; }

sudo apt-get update
sudo apt-get install -y cloud-image-utils openssh-client qemu-system-x86 qemu-utils xz-utils
sudo /usr/bin/bash "$node_installer" x64
if ! getent group kvm >/dev/null; then
  sudo groupadd --system kvm
fi
if [[ " $(id -nG "$install_user") " != *" kvm "* ]]; then
  sudo usermod -aG kvm "$install_user"
fi

for command in qemu-system-x86_64 qemu-img cloud-localds ssh; do
  command -v "$command" >/dev/null || { echo "missing KVM dependency after installation: $command" >&2; exit 1; }
done
echo "KVM dependencies installed; runtime access is checked only after a refreshed login"
