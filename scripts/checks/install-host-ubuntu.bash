#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/runtime-backends.bash
source "$script_dir/lib/runtime-backends.bash"

backend="${1:-}"
if ! dim_is_runtime_backend "$backend"; then
  echo "usage: $0 <$(dim_runtime_backend_choices)> [ubuntu|docker-ce]" >&2
  exit 2
fi
docker_source="${2:-ubuntu}"
case "$docker_source" in ubuntu|docker-ce) ;; *) echo "Docker source must be ubuntu or docker-ce" >&2; exit 2 ;; esac
install_user="${SUDO_USER:-$(id -un)}"
[[ "$install_user" != root ]] || install_user=""

sysbox_version="${SYSBOX_VERSION:-0.7.0}"
sysbox_arch="${SYSBOX_ARCH:-$(dpkg --print-architecture)}"
sysbox_deb=""
apparmor_local_profile="/etc/apparmor.d/local/fusermount3"
apparmor_rule_marker="# dev-infra-manager: allow Sysbox FUSE mounts"

cleanup() {
  [[ -z "$sysbox_deb" ]] || rm -f -- "$sysbox_deb"
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
  - install common APT packages: apparmor, curl, docker.io, docker-buildx, docker-compose-v2, jq
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
    sudo apt-get install -y apparmor curl jq
  else
    sudo apt-get update
    sudo apt-get install -y apparmor curl docker.io docker-buildx docker-compose-v2 jq
  fi
}

install_sysbox() {
  local checksum url
  case "$sysbox_arch" in
    arm64) checksum="eae9c0e91ddd39bd1826d6a7a313a73d42a8449ef5113e9d6d118b559cb809ba" ;;
    amd64) checksum="eeff273671467b8fa351ab3d40709759462dc03d9f7b50a1b207b37982ce40a9" ;;
    *) echo "Unsupported architecture for pinned Sysbox package: $sysbox_arch" >&2; exit 2 ;;
  esac

  sysbox_deb="$(mktemp --suffix=.deb "/tmp/sysbox-ce_${sysbox_version}-0.linux_${sysbox_arch}.XXXXXX")"
  url="https://downloads.nestybox.com/sysbox/releases/v${sysbox_version}/sysbox-ce_${sysbox_version}-0.linux_${sysbox_arch}.deb"
  curl -L -o "$sysbox_deb" "$url"
  echo "${checksum}  ${sysbox_deb}" | sha256sum -c -
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
