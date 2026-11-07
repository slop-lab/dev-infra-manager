#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" == 0 ]] || { echo 'practical VM dependencies require root' >&2; exit 1; }
# This harness owns both cold preparation and immutable dependency baselines.
# Incus needs dnsmasq even when APT recommendations are deliberately disabled.
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  incus incus-agent dnsmasq-base virtiofsd qemu-system-x86 qemu-system-modules-spice \
  qemu-utils ovmf build-essential genisoimage iptables iproute2
if ! command -v dnsmasq >/dev/null || ! dnsmasq --version >/dev/null; then
  echo 'practical VM dependencies did not provide working dnsmasq' >&2
  exit 1
fi
# Noble packages keep these private executables outside the interactive PATH.
[[ -x /usr/libexec/incus/incus-agent ]] || { echo 'Incus VM agent is unavailable' >&2; exit 1; }
/usr/libexec/virtiofsd --version >/dev/null
qemu-system-x86_64 -spice help >/dev/null
