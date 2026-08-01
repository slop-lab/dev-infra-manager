#!/usr/bin/env bash
set -euo pipefail

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
  - install QEMU, qcow2, cloud-image, and SSH client tooling
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
  cloud-image-utils \
  openssh-client \
  qemu-system-x86 \
  qemu-utils

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
if [[ ! -c /dev/kvm ]]; then
  echo "/dev/kvm is not available as a character device" >&2
  exit 1
fi

if [[ -n "$install_user" ]]; then
  if ! sudo -u "$install_user" sg kvm -c 'test -r /dev/kvm -a -w /dev/kvm'; then
    echo "user '$install_user' cannot access /dev/kvm through the kvm group" >&2
    exit 1
  fi
  cat <<EOF
KVM verification dependencies installed. User '$install_user' belongs to the kvm group.

Group membership is permanent, but the current login session must be refreshed once.
Either log out and back in, or run:

  newgrp kvm

Then run:

  just verify-environments-kvm
EOF
else
  test -r /dev/kvm -a -w /dev/kvm
  echo "KVM verification dependencies installed. Run: just verify-environments-kvm"
fi
