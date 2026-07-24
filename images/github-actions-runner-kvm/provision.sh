#!/usr/bin/env bash
set -euo pipefail

runner_version="${1:?runner version is required}"
runner_sha256="${2:?runner SHA-256 is required}"
source_root="${3:-/tmp/dim-runner-source}"
runner_root="/opt/actions-runner"
archive="/tmp/actions-runner-linux-x64-${runner_version}.tar.gz"

sudo apt-get update
sudo apt-get install -y \
  curl git jq just \
  qemu-system-x86 qemu-utils cloud-image-utils openssh-client

printf 'yes\n' | bash "$source_root/scripts/install-host-ubuntu.sh" sysbox

sudo modprobe kvm
if grep -qw vmx /proc/cpuinfo; then
  sudo modprobe kvm_intel
elif grep -qw svm /proc/cpuinfo; then
  sudo modprobe kvm_amd
else
  echo "nested virtualization CPU flag (vmx or svm) is not visible in the guest" >&2
  exit 1
fi
test -c /dev/kvm
sudo usermod -aG kvm,docker dim

curl -fsSL \
  -o "$archive" \
  "https://github.com/actions/runner/releases/download/v${runner_version}/actions-runner-linux-x64-${runner_version}.tar.gz"
echo "${runner_sha256}  ${archive}" | sha256sum -c -
sudo install -d -o dim -g dim -m 0755 "$runner_root"
sudo -u dim tar -C "$runner_root" -xzf "$archive"
sudo "$runner_root/bin/installdependencies.sh"

sudo rm -f -- "$archive"
sudo cloud-init clean --logs --seed
