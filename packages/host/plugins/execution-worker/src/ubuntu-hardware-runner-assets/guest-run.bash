#!/bin/bash
set -euo pipefail
exec >/dev/ttyS0 2>&1
stty -F /dev/ttyS0 -onlcr
finish() { status=$?; trap - EXIT; printf '%s\n' "$status" >/dev/virtio-ports/dim.result || true; sync; /mnt/dim-tools/guest-exit "$status" || true; poweroff -f; }
trap finish EXIT
mkdir -p /run/dim/job /mnt/dim-tools /mnt/dim-source /workspace /scratch
mount -t 9p -o trans=virtio,ro job /run/dim/job
mount -t 9p -o trans=virtio,ro tools /mnt/dim-tools
mount -t 9p -o trans=virtio workspace /mnt/dim-source
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
cp -a /mnt/dim-source/. /workspace/
mkdir -p /mnt/dim-source/.dim-ci-artifacts /workspace/.dim-ci-artifacts
chown dim:dim /mnt/dim-source/.dim-ci-artifacts
chown -R dim:dim /workspace /scratch/tmp
chmod 1777 /scratch/tmp
# Evidence is written through this share while running, including failure paths.
mount --bind /mnt/dim-source/.dim-ci-artifacts /workspace/.dim-ci-artifacts
while read -r source target; do
  [[ -n "$source" ]] || continue
  mkdir -p "${target%/*}"; touch "$target"
  mount --bind "/run/dim/job/$source" "$target"
  mount -o remount,bind,ro "$target"
done </run/dim/job/config-targets
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
systemd-run --unit=dim-hardware-candidate --wait --pipe --uid=dim --property=TasksMax=@DIM_PIDS@ /run/dim/run-job
