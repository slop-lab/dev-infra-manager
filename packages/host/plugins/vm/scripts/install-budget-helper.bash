#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_PROFILE LD_ASSUME_KERNEL

fail() { printf 'dim-vm-budget setup: %s\n' "$*" >&2; exit 2; }
[[ "$(/usr/bin/id -u)" == 0 ]] || fail 'run this explicit host setup as root'
[[ $# == 3 ]] || fail 'usage: install-budget-helper.bash TRUSTED_NODE ROOT_CONFIG.json HOST_USER'
node="$1"; reviewed_config="$2"; host_user="$3"
[[ "$node" =~ ^/[a-zA-Z0-9_./-]+$ && "$host_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'invalid trusted Node path or host user'
[[ -f "$node" && -x "$node" && ! -L "$node" && "$(/usr/bin/readlink -f "$node")" == "$node" ]] || fail 'Node must be a canonical regular executable'
component="$node"
while true; do
  metadata="$(/usr/bin/stat -c '%u:%a' "$component")"
  mode="${metadata#*:}"
  [[ "${metadata%%:*}" == 0 ]] && (( (8#$mode & 8#022) == 0 )) || fail 'Node and ancestors must be root-owned and not group/world-writable'
  [[ "$component" == / ]] && break
  component="$(/usr/bin/dirname "$component")"
done
case "$("$node" --version)" in v24.*|v26.*) ;; *) fail 'trusted Node must be version 24 or 26' ;; esac
/usr/bin/getent passwd "$host_user" >/dev/null || fail 'host user does not exist'
command -v visudo >/dev/null || fail 'sudo and visudo must already be installed'
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$script_directory/budget-cli.js" ]]; then artifact_root="$script_directory"; else artifact_root="$script_directory/../dist"; fi
modules=(budget-cli budget budget-lock budget-policy budget-qemu)
for module in "${modules[@]}"; do [[ -f "$artifact_root/$module.js" ]] || fail 'build the exact reviewed plugin artifact before root setup'; done
# The operator selects this input explicitly; copy it into root-owned storage before parsing.
for directory in /etc/dim /usr/local/lib/dim-vm-budget /usr/local/bin /etc/sudoers.d; do
  [[ ! -L "$directory" ]] || fail "managed directory must not be a symlink: $directory"
  if [[ -e "$directory" ]]; then
    metadata="$(/usr/bin/stat -c '%u:%a' "$directory")"; mode="${metadata#*:}"
    [[ "${metadata%%:*}" == 0 ]] && (( (8#$mode & 8#022) == 0 )) || fail "untrusted managed directory: $directory"
  fi
done
/usr/bin/install -d -o root -g root -m 0755 /etc/dim /usr/local/lib/dim-vm-budget/releases /usr/local/bin /etc/sudoers.d
stage="$(/usr/bin/mktemp -d /usr/local/lib/dim-vm-budget/.setup.XXXXXX)"
trap 'rm -rf -- "$stage"' EXIT
/usr/bin/install -o root -g root -m 0600 "$reviewed_config" "$stage/config.json"
"$node" --input-type=module - "$stage/config.json" <<'NODE'
import { readFileSync } from 'node:fs';
import path from 'node:path';
const value = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join() !== 'cgroupRoot,incusSocket,project,qemuExecutable,schemaVersion' || value.schemaVersion !== 1 ||
    typeof value.project !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(value.project) ||
    typeof value.incusSocket !== 'string' || !path.isAbsolute(value.incusSocket) ||
    typeof value.cgroupRoot !== 'string' || !value.cgroupRoot.startsWith('/sys/fs/cgroup/') ||
    path.normalize(value.cgroupRoot) !== value.cgroupRoot ||
    typeof value.qemuExecutable !== 'string' || !path.isAbsolute(value.qemuExecutable) ||
    !/^qemu-system-[a-zA-Z0-9_-]+$/.test(path.basename(value.qemuExecutable))) throw new Error('invalid reviewed VM budget root configuration');
NODE
for module in "${modules[@]}"; do /usr/bin/install -o root -g root -m 0444 "$artifact_root/$module.js" "$stage/$module.js"; done
printf '{"type":"module"}\n' >"$stage/package.json"
printf '#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root %s /usr/local/lib/dim-vm-budget/current/budget-cli.js "$@"\n' "$node" >"$stage/helper"
printf '%s ALL=(root) NOPASSWD: /usr/local/bin/dim-vm-budget prepare, /usr/local/bin/dim-vm-budget apply, /usr/local/bin/dim-vm-budget verify, /usr/local/bin/dim-vm-budget release\n' "$host_user" >"$stage/sudoers"
visudo -cf "$stage/sudoers" >/dev/null
# Immutable versioned code and atomic pointer replacement prevent mixed helper versions.
release="$(for module in "${modules[@]}"; do cat "$stage/$module.js"; done | sha256sum | cut -d ' ' -f 1)"
release_dir="/usr/local/lib/dim-vm-budget/releases/$release"
if [[ ! -d "$release_dir" ]]; then
  /usr/bin/install -d -o root -g root -m 0755 "$release_dir"
  for module in "${modules[@]}"; do /usr/bin/install -o root -g root -m 0444 "$stage/$module.js" "$release_dir/$module.js"; done
  /usr/bin/install -o root -g root -m 0444 "$stage/package.json" "$release_dir/package.json"
fi
ln -s "releases/$release" "$stage/current"
mv -Tf -- "$stage/current" /usr/local/lib/dim-vm-budget/current
/usr/bin/install -o root -g root -m 0600 "$stage/config.json" /etc/dim/.vm-budget.new
mv -Tf -- /etc/dim/.vm-budget.new /etc/dim/vm-budget.json
/usr/bin/install -o root -g root -m 0555 "$stage/helper" /usr/local/bin/.dim-vm-budget.new
mv -Tf -- /usr/local/bin/.dim-vm-budget.new /usr/local/bin/dim-vm-budget
/usr/bin/install -o root -g root -m 0440 "$stage/sudoers" /etc/sudoers.d/.dim-vm-budget.new
mv -Tf -- /etc/sudoers.d/.dim-vm-budget.new /etc/sudoers.d/dim-vm-budget
printf 'VM budget helper installed for %s. Set budgetHelper to /usr/local/bin/dim-vm-budget in that host user VM configuration.\n' "$host_user"
# A dedicated PATH entry lets Incus keep managing machines while every DIM QEMU fork inherits its UUID budget.
qemu_name="$("$node" --input-type=module -e 'import fs from "node:fs";import p from "node:path";console.log(p.basename(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).qemuExecutable))' "$stage/config.json")"
/usr/bin/install -d -o root -g root -m 0755 /usr/local/lib/dim-vm-budget/qemu /etc/systemd/system/incus.service.d
qemu_binary="$("$node" --input-type=module -e 'import fs from "node:fs";console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).qemuExecutable)' "$stage/config.json")"
[[ "$qemu_binary" =~ ^/[a-zA-Z0-9_./-]+$ ]] || fail 'QEMU executable path contains unsupported characters'
cat >"$stage/qemu" <<QEMU
#!/bin/sh
needs_admission=false
previous=''
for argument in "\$@"; do
  if [ "\$previous" = -name ]; then
    case "\$argument" in dim-????????-????-????-????-????????????|dim-????????-????-????-????-????????????,*) needs_admission=true ;; esac
    break
  fi
  previous="\$argument"
done
if [ "\$needs_admission" = true ]; then
  /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root "$node" /usr/local/lib/dim-vm-budget/current/budget-qemu.js "\$\$" "\$@" || exit "\$?"
  exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root "$qemu_binary" "\$@"
fi
exec "$qemu_binary" "\$@"
QEMU
/usr/bin/install -o root -g root -m 0555 "$stage/qemu" "/usr/local/lib/dim-vm-budget/qemu/$qemu_name"
printf '[Service]\nEnvironment="PATH=/usr/local/lib/dim-vm-budget/qemu:/usr/libexec/incus:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\n' >"$stage/service.conf"
/usr/bin/install -o root -g root -m 0644 "$stage/service.conf" /etc/systemd/system/incus.service.d/dim-vm-budget.conf
printf 'Review the Incus PATH drop-in, then explicitly run systemctl daemon-reload and restart incus before starting DIM VMs. Existing unrelated VMs are passed through unchanged.\n'
