#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/runtime-backends.bash
source "$script_dir/lib/runtime-backends.bash"
source "$script_dir/../lib/bootstrap-ubuntu-pins.bash"
source "$script_dir/lib/bootstrap-download.bash"

backend="${1:-}"
if ! dim_is_runtime_backend "$backend"; then
  echo "usage: $0 <$(dim_runtime_backend_choices)> [ubuntu|docker-ce]" >&2
  exit 2
fi
docker_source="${2:-docker-ce}"
case "$docker_source" in ubuntu|docker-ce) ;; *) echo "Docker source must be ubuntu or docker-ce" >&2; exit 2 ;; esac
install_user="${SUDO_USER:-$(id -un)}"
[[ "$install_user" != root ]] || install_user=""

sysbox_version="${SYSBOX_VERSION:-$dim_sysbox_version}"
sysbox_arch="${SYSBOX_ARCH:-$(dpkg --print-architecture)}"
sysbox_deb=""
sysbox_work=""
apparmor_local_profile="/etc/apparmor.d/local/fusermount3"
apparmor_rule_marker="# dev-infra-manager: allow Sysbox FUSE mounts"

cleanup() {
  [[ -z "$sysbox_work" ]] || rm -rf -- "$sysbox_work"
}
trap cleanup EXIT

confirm_install() {
  cat <<EOF
Ubuntu host backend installer (${backend})
=================================

This script is a development convenience, not production hardening guidance.
Review and adapt every change before using it on a production host.

EOF
  if [[ "$docker_source" == docker-ce ]]; then
    echo "  - install exact signed Docker CE 29.1.4, containerd.io, Buildx, and Compose plugin packages"
    echo "  - require Docker's containerd image store without replacing daemon configuration"
  else
    cat <<'EOF'
  - install common APT packages: apparmor, ca-certificates, curl, docker.io, docker-buildx, docker-compose-v2, git, jq, openssh-client, xz-utils
EOF
  fi
  cat <<'EOF'
  - when required by Ubuntu, allow /usr/local/bin/rootlesskit to create its user namespace
  - install and configure the Sysbox backend
EOF
  if [[ -n "$install_user" ]]; then
    echo "  - permanently add user '$install_user' to the docker group"
  fi
  cat <<'EOF'

Backend installation may change Docker, systemd, AppArmor, FUSE, and user-group configuration.
Type yes to continue; any other input cancels installation.
EOF
  if [[ "${DIM_HOST_INSTALL_ASSUME_YES:-0}" == 1 ]]; then
    confirmation=yes
  else
    read -r -p "> " confirmation
  fi
  if [[ "$confirmation" != yes ]]; then
    echo "Installation cancelled."
    exit 1
  fi
}

install_common_packages() {
  if [[ "$docker_source" == docker-ce ]]; then
    sudo /usr/bin/bash "$script_dir/lib/install-docker-ce-ubuntu.bash"
    sudo apt-get update
    sudo apt-get install -y apparmor ca-certificates curl git jq openssh-client xz-utils
  else
    sudo apt-get update
    sudo apt-get install -y apparmor ca-certificates curl docker.io docker-buildx docker-compose-v2 git jq openssh-client xz-utils
  fi
}

install_sysbox() {
  local checksum url
  [[ "$sysbox_version" == "$dim_sysbox_version" ]] || { echo 'unsupported Sysbox version; use the reviewed pin' >&2; exit 2; }
  dim_bootstrap_artifact sysbox "$sysbox_arch"
  checksum="$dim_artifact_sha256"; url="$dim_artifact_url"
  sysbox_work="$(mktemp -d /tmp/dim-sysbox-install.XXXXXX)"
  sysbox_deb="$sysbox_work/sysbox.deb"
  dim_bootstrap_download "$url" "$checksum" "$sysbox_deb"
  sudo apt-get install -y "$sysbox_deb"

  if [[ -f /etc/apparmor.d/fusermount3 ]]; then
    sudo install -d -m 0755 "$(dirname -- "$apparmor_local_profile")"
    if ! sudo grep -Fqx "$apparmor_rule_marker" "$apparmor_local_profile" 2>/dev/null; then
      printf '%s\n' \
        '' \
        "$apparmor_rule_marker" \
        'mount fstype=@{fuse_types} options=(nosuid,nodev) options in (ro,rw,noatime,dirsync,nodiratime,noexec,sync) -> /var/lib/sysboxfs/**/,' \
        'umount /var/lib/sysboxfs/**/,' \
        | sudo tee -a "$apparmor_local_profile" >/dev/null
    fi
    sudo apparmor_parser -r /etc/apparmor.d/fusermount3
  fi

  sudo systemctl daemon-reload
  sudo systemctl restart docker
  sudo systemctl restart sysbox
}

install_selected_backend() {
  install_sysbox
}

configure_install_user() {
  [[ -n "$install_user" ]] || return 0
  if [[ " $(id -nG "$install_user") " != *" docker "* ]]; then
    sudo usermod -aG docker "$install_user"
  fi
  cat <<EOF
Host install complete. User '$install_user' belongs to the docker group.

Group membership is permanent, but the current login session must be refreshed once.
Either log out and back in, or run:

  newgrp docker

Then run:

  just run-cli doctor
EOF
}


confirm_install
install_common_packages
sudo bash "$script_dir/install-rootlesskit-apparmor-profile-ubuntu.bash"
install_selected_backend
configure_install_user
if [[ -z "$install_user" ]]; then
  echo "Host install complete. Run: just run-cli doctor"
fi
