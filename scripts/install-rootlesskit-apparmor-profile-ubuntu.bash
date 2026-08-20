#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == --docker-host ]]; then
  [[ "$#" -eq 1 ]] || { echo "usage: $0 [--docker-host]" >&2; exit 2; }
  repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
  image="dim-rootlesskit-apparmor-loader:ci"
  docker build --quiet --tag "$image" \
    --file "$repository_root/images/rootlesskit-apparmor-loader/Dockerfile" \
    "$repository_root" >/dev/null
  docker run --rm --privileged --pid host \
    --mount type=bind,source=/sys/kernel/security,target=/sys/kernel/security \
    "$image"
  exit 0
fi
[[ "$#" -eq 0 ]] || { echo "usage: $0 [--docker-host]" >&2; exit 2; }

if [[ "${EUID}" -ne 0 ]]; then
  echo "install-rootlesskit-apparmor-profile-ubuntu.bash must run as root" >&2
  exit 2
fi
[[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] || exit 0
command -v apparmor_parser >/dev/null || exit 0
# Containerized CI jobs can see the host's restriction sysctl without being
# given the securityfs policy interface. In that case the runner host owns
# policy loading, and invoking apparmor_parser here can only fail.
[[ -w /sys/kernel/security/apparmor/.load ]] || exit 0

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
