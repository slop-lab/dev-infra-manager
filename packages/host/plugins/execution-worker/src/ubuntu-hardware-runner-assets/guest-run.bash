#!/bin/bash
set -euo pipefail
exec >/dev/ttyS0 2>&1
stty -F /dev/ttyS0 -onlcr
# Keep the serial descriptor separate so EXIT can close the logging pipe and
# reap its exact tee process before the result receipt/debug-exit ends the VM.
exec 3>&1
log_pid=
finish() {
  status=$?; trap - EXIT; set +e
  exec 1>&3 2>&3
  if [[ -n "$log_pid" ]]; then wait "$log_pid"; fi
  printf '%s\n' "$status" >/dev/virtio-ports/dim.result || true
  sync
  /mnt/dim-tools/guest-exit "$status" || true
  poweroff -f
}
trap finish EXIT
mkdir -p /run/dim/job /mnt/dim-tools /mnt/dim-source /workspace /scratch
chmod 0755 /run/dim
mount -t 9p -o trans=virtio,ro job /run/dim/job
mount -t 9p -o trans=virtio,ro tools /mnt/dim-tools
mount -t 9p -o trans=virtio workspace /mnt/dim-source
cp -a /mnt/dim-source/. /workspace/
mkdir -p /mnt/dim-source/.dim-ci-artifacts /workspace/.dim-ci-artifacts
chown dim:dim /mnt/dim-source/.dim-ci-artifacts
chown -R dim:dim /workspace
# Evidence is written through this share while running, including failure paths.
mount --bind /mnt/dim-source/.dim-ci-artifacts /workspace/.dim-ci-artifacts
exec > >(tee /mnt/dim-source/.dim-ci-artifacts/bootstrap.log >&3) 2>&1
log_pid=$!
while read -r source target; do
  [[ -n "$source" ]] || continue
  mkdir -p "${target%/*}"; touch "$target"
  mount --bind "/run/dim/job/$source" "$target"
  mount -o remount,bind,ro "$target"
done </run/dim/job/config-targets
source /run/dim/job/job-environment
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Mirror routing, when selected by the operator, is bound before the first APT
# request. Signed indexes and immutable By-Hash retain integrity on the normal
# HTTP APT relay path; do not silently bypass the selected relay with HTTPS.
apt_status=100
for attempt in 1 2 3; do
  if timeout --signal=TERM --kill-after=10s 180s apt-get -o Acquire::Retries=2 -o Acquire::By-Hash=force -o APT::Update::Error-Mode=any update; then
    apt_status=0; break
  else apt_status=$?; fi
  [[ "$attempt" == 3 ]] || sleep 3
done
[[ "$apt_status" == 0 ]] || exit "$apt_status"
timeout --signal=TERM --kill-after=10s 600s env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=2 -o Acquire::By-Hash=force install -y --no-install-recommends python3 git curl ca-certificates build-essential qemu-system-x86 qemu-utils cloud-image-utils genisoimage openssh-client xz-utils libatomic1
# A separate fixed-size disk carries temporary VM overlays; never RAM tmpfs.
mkfs.ext4 -q -F /dev/vdb
mount -o nosuid,nodev /dev/vdb /scratch
mkdir -p /scratch/tmp
chmod 1777 /scratch/tmp
mount --bind /scratch/tmp /tmp
cp /mnt/dim-tools/node /usr/local/bin/node
chmod 0755 /usr/local/bin/node
modprobe kvm
case "$(LC_ALL=C lscpu | sed -n 's/^Vendor ID:[[:space:]]*//p')" in
  AuthenticAMD) modprobe kvm_amd ;;
  GenuineIntel) modprobe kvm_intel ;;
  *) echo 'unsupported nested KVM vendor' >&2; exit 2 ;;
esac
usermod -aG kvm dim
runuser -u dim -- python3 - <<'KVM'
import os,fcntl,stat
fd=os.open('/dev/kvm',os.O_RDWR|os.O_NOFOLLOW)
try:
 assert stat.S_ISCHR(os.fstat(fd).st_mode)
 assert fcntl.ioctl(fd,0xae00,0)==12
 vm=fcntl.ioctl(fd,0xae01,0);os.close(vm)
 print('hardware guest KVM API12/create-close PASS')
finally:os.close(fd)
KVM
cat >/run/dim/run-job <<'JOB'
#!/bin/bash
set -euo pipefail
source /run/dim/job/job-environment
export HOME=/home/dim
export PATH=/usr/local/bin:/usr/bin:/bin
export DIM_ARTIFACTS_DIR=/workspace/.dim-ci-artifacts
cd -- "$(cat /run/dim/job/working-directory)"
exec /bin/bash --noprofile --norc /run/dim/job/script
JOB
chmod 0555 /run/dim/run-job
stat --format='hardware path mode=%a uid=%u gid=%g path=%n' /run /run/dim /run/dim/run-job
findmnt --noheadings --output TARGET,OPTIONS --target /run/dim/run-job
runuser -u dim -- test -x /run && runuser -u dim -- test -x /run/dim && runuser -u dim -- test -r /run/dim/run-job || {
  echo "hardware job path is not readable/traversable by dim" >&2
  exit 2
}
runuser -u dim -- test -r /run/dim/job/script || { echo "hardware job script is not readable by dim" >&2; exit 2; }
runuser -u dim -- test -w /workspace/.dim-ci-artifacts || { echo "hardware artifacts are not writable by dim" >&2; exit 2; }
systemd-run --unit=dim-hardware-candidate --wait --pipe --uid=dim --property=TasksMax=@DIM_PIDS@ /bin/bash --noprofile --norc /run/dim/run-job
