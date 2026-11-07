#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
repository="$1" output="$2" BOOTSTRAP_BASE_IMAGE="$3"
script_dir="$repository/scripts/checks"
source "$script_dir/lib/bootstrap-ubuntu-vm-guest.bash"
BOOTSTRAP_WORK_ROOT="$(mktemp -d "${TMPDIR:-/var/tmp}/dim-baseline-build.XXXXXXXX")"
BOOTSTRAP_EVIDENCE_ROOT="$output/build-evidence"
mkdir -m 0700 "$BOOTSTRAP_EVIDENCE_ROOT"
cleanup() {
  status=$?; trap - EXIT
  if ! bootstrap_guest_stop; then
    echo "baseline guest cleanup uncertain; preserved=$BOOTSTRAP_WORK_ROOT" >&2
    exit 125
  fi
  rm -rf -- "$BOOTSTRAP_WORK_ROOT"
  exit "$status"
}
trap cleanup EXIT
mapfile -t inputs < <(node "$script_dir/vm-baseline.ts" recipe-files)
[[ "${#inputs[@]}" -gt 5 ]] || exit 2
tar -cf "$BOOTSTRAP_WORK_ROOT/inputs.tar" -C "$repository" "${inputs[@]}"
for role in control-plane host; do
  memory=3072; [[ "$role" != host ]] || memory=8192
  bootstrap_guest_start "baseline-$role" "$memory"
  timeout 300s "${BOOTSTRAP_SCP[@]}" "$BOOTSTRAP_WORK_ROOT/inputs.tar" dim@127.0.0.1:/tmp/dim-baseline-inputs.tar
  timeout --signal=TERM --kill-after=30s 5400s "${BOOTSTRAP_SSH[@]}" bash -s -- "$role" >"$BOOTSTRAP_EVIDENCE_ROOT/$role-install.log" 2>&1 <<'REMOTE'
set -euo pipefail
role="$1"
mkdir -m 0700 /tmp/dim-baseline-inputs
tar -xf /tmp/dim-baseline-inputs.tar -C /tmp/dim-baseline-inputs
cd /tmp/dim-baseline-inputs
sudo bash scripts/checks/lib/install-source-tools-ubuntu.bash
if [[ "$role" == host ]]; then
  DIM_HOST_INSTALL_ASSUME_YES=1 bash scripts/checks/install-host-ubuntu.bash sysbox docker-ce
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends incus qemu-system-x86 qemu-utils ovmf build-essential genisoimage iptables iproute2
  sudo usermod -aG incus-admin,kvm,docker dim
fi
sudo dpkg-query -W -f='${Package}\t${Version}\n' > /tmp/dim-baseline-packages.txt
REMOTE
  timeout 60s "${BOOTSTRAP_SCP[@]}" dim@127.0.0.1:/tmp/dim-baseline-packages.txt "$BOOTSTRAP_EVIDENCE_ROOT/$role-packages.txt"
  # There is no DIM install, source checkout, bootstrap marker, workload, Incus
  # project/network or credential in this dependency-only artifact.
  set +e
  timeout 600s "${BOOTSTRAP_SSH[@]}" bash -s -- "$role" <<'REMOTE'
set -euo pipefail
if [[ "$1" == host ]]; then
  [[ -z "$(sudo docker ps -aq)" && -z "$(sudo docker image ls -q)" && -z "$(sudo docker volume ls -q)" ]]
  sudo systemctl stop incus.socket incus.service docker.socket docker.service containerd.service sysbox.service
  sudo rm -rf /var/lib/incus /var/lib/docker /var/lib/containerd
fi
sudo rm -rf /tmp/dim-baseline-inputs /tmp/dim-baseline-inputs.tar /tmp/dim-baseline-packages.txt
sudo rm -rf /home/dim/.ssh /home/dim/.config /home/dim/.local /root/.ssh /root/.config /root/.local
sudo rm -f /etc/ssh/ssh_host_* /var/lib/dbus/machine-id
sudo cloud-init clean --logs --machine-id --seed
# Deleted cloud-init/SSH material must not survive in reusable free disk blocks.
# Only this newly built disposable guest's free space is filled, then removed.
sudo bash -c 'set -eu; set -o noclobber; : >/.dim-baseline-free-space; if dd if=/dev/zero of=/.dim-baseline-free-space bs=16M status=none; then :; else available=$(df -B1 --output=avail / | tail -n 1); ((available < 16777216)); fi; rm /.dim-baseline-free-space'
sudo sync
sudo poweroff
REMOTE
  shutdown_status=$?
  set -e
  [[ "$shutdown_status" == 0 || "$shutdown_status" == 255 ]] || exit "$shutdown_status"
  deadline=$((SECONDS + 120))
  while [[ -e "/proc/$BOOTSTRAP_QEMU_PID/stat" && "$(cut -d' ' -f3 "/proc/$BOOTSTRAP_QEMU_PID/stat")" != Z ]]; do
    ((SECONDS < deadline)) || { echo 'baseline guest did not shut down' >&2; exit 1; }
    sleep 1
  done
  wait "$BOOTSTRAP_QEMU_PID" || true
  BOOTSTRAP_QEMU_PID=""
  # Flatten the complete dependency disk; a backing-chain artifact is forbidden.
  qemu-img convert -O qcow2 "$BOOTSTRAP_GUEST_ROOT/root.qcow2" "$output/$role.qcow2"
  rm -rf -- "$BOOTSTRAP_GUEST_ROOT"
  BOOTSTRAP_GUEST_ROOT=""
done
