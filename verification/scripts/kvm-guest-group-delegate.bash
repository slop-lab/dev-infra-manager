#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
instance_id_path=/var/lib/cloud/data/instance-id
vendor_path=/sys/class/dmi/id/sys_vendor

refuse() {
  printf 'KVM group delegation is restricted to the disposable QEMU verification guest\n' >&2
  exit 2
}

guest_guard() {
  local cwd instance_owner vendor
  [[ "$(id -u)" == 1001 ]] || refuse
  cwd="$(pwd -P)"
  [[ "$repo_root" == /home/dim/dim/workbench \
    && ( "$cwd" == /home/dim/dim/workbench || "$cwd" == /home/dim/dim/workbench/* ) ]] || refuse
  [[ -f "$instance_id_path" && ! -L "$instance_id_path" ]] || refuse
  instance_owner="$(/usr/bin/stat -Lc '%u' -- "$instance_id_path")" || refuse
  [[ "$instance_owner" == 0 && "$(<"$instance_id_path")" == dim-kvm-smoke ]] || refuse
  [[ -r "$vendor_path" ]] || refuse
  vendor="$(<"$vendor_path")"
  [[ "$vendor" == QEMU ]] || refuse
  [[ -c /dev/kvm ]] || refuse
}

kvm_preflight() {
  local device cpu_virtualization=absent
  device="$(/usr/bin/stat -Lc 'kind=%F mode=%a uid=%u gid=%g' -- /dev/kvm)"
  if /usr/bin/grep -Eq '(^|[[:space:]])(vmx|svm)([[:space:]]|$)' /proc/cpuinfo; then
    cpu_virtualization=present
  fi
  printf 'kvm-ready diagnostic device=%s identity=uid:%s gid:%s groups:%s cpu-vmx-or-svm=%s\n' \
    "$device" "$(id -u)" "$(id -g)" "$(id -Gn)" "$cpu_virtualization" >&2
  [[ -r /dev/kvm && -w /dev/kvm ]] || {
    printf 'native guest verification requires accessible KVM; hardware absence is unavailable\n' >&2
    return 2
  }
}

qemu_mechanics() {
  kvm_preflight
  cd "$repo_root"
  exec /usr/bin/bash "$script_dir/native-qemu-guest-mechanics-kvm-smoke.bash"
}

fresh_ubuntu_bootstrap() {
  kvm_preflight
  cd "$repo_root"
  exec /usr/bin/bash "$script_dir/bootstrap-ubuntu-vm-smoke.bash" \
    --source-bundle /mnt/dim-inputs/bootstrap-source/root.bundle \
    --source-manifest /mnt/dim-inputs/bootstrap-source/manifest.json
}

delegate() {
  local action="$1" uid gid kvm_gid groups groups_csv
  uid="$(id -u)"
  gid="$(id -g)"
  kvm_gid="$(/usr/bin/stat -Lc '%g' -- /dev/kvm)"
  [[ "$kvm_gid" =~ ^[0-9]+$ ]] || refuse
  groups="$(id -G)"
  if [[ " $groups " != *" $kvm_gid "* ]]; then groups="$groups $kvm_gid"; fi
  groups_csv="${groups// /,}"
  exec /usr/bin/sudo -n /usr/bin/setpriv \
    --reuid="$uid" --regid="$gid" --groups="$groups_csv" --no-new-privs -- \
    /usr/bin/env HOME=/home/dim USER=dim LOGNAME=dim PATH="$PATH" DIM_KVM_GUEST_DELEGATED=1 \
    /usr/bin/bash "$script_dir/kvm-guest-group-delegate.bash" "$action"
}

[[ "$#" -eq 1 ]] || refuse
action="$1"
case "$action" in
  preflight|run|bootstrap) ;;
  *) refuse ;;
esac
guest_guard

if [[ "${DIM_KVM_GUEST_DELEGATED:-}" == 1 ]]; then
  kvm_gid="$(/usr/bin/stat -Lc '%g' -- /dev/kvm)"
  [[ " $(id -G) " == *" $kvm_gid "* ]] || refuse
  case "$action" in
    preflight) kvm_preflight ;;
    run) qemu_mechanics ;;
    bootstrap) fresh_ubuntu_bootstrap ;;
  esac
else
  delegate "$action"
fi
