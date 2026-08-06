#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "install-rootlesskit-apparmor-profile-ubuntu.bash must run as root" >&2
  exit 2
fi
[[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] || exit 0
command -v apparmor_parser >/dev/null || exit 0

profile="/etc/apparmor.d/usr.local.bin.rootlesskit"
cat >"$profile" <<'EOF'
abi <abi/4.0>,
include <tunables/global>

"/usr/local/bin/rootlesskit" flags=(unconfined) {
  userns,

  include if exists <local/usr.local.bin.rootlesskit>
}
EOF
apparmor_parser -r "$profile"
