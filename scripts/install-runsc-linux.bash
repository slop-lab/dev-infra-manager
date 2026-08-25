#!/usr/bin/env bash
set -euo pipefail

GVISOR_CHANNEL="${GVISOR_CHANNEL:-release/latest}"
ARCH="${GVISOR_ARCH:-$(uname -m)}"
URL="https://storage.googleapis.com/gvisor/releases/${GVISOR_CHANNEL}/${ARCH}"
workdir="$(mktemp -d /tmp/runsc-install-XXXXXX)"

cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT

cd "$workdir"
curl -fsSLO "${URL}/runsc"
curl -fsSLO "${URL}/runsc.sha512"
curl -fsSLO "${URL}/containerd-shim-runsc-v1"
curl -fsSLO "${URL}/containerd-shim-runsc-v1.sha512"

sha512sum -c runsc.sha512 -c containerd-shim-runsc-v1.sha512
chmod a+rx runsc containerd-shim-runsc-v1

sudo mv runsc containerd-shim-runsc-v1 /usr/local/bin/
sudo /usr/local/bin/runsc install
daemon_config="$(mktemp /tmp/dim-runsc-daemon-XXXXXX.json)"
sudo jq '
  .runtimes.runsc.runtimeArgs =
    (((.runtimes.runsc.runtimeArgs // []) + ["--host-uds=open"]) | unique)
' /etc/docker/daemon.json >"$daemon_config"
sudo install -m 0644 "$daemon_config" /etc/docker/daemon.json
rm -f "$daemon_config"
sudo systemctl restart docker

/usr/local/bin/runsc --version
echo "runsc installed and registered with Docker."
