#!/usr/bin/env bash
set -euo pipefail

SYSBOX_VERSION="${SYSBOX_VERSION:-0.7.0}"
SYSBOX_ARCH="${SYSBOX_ARCH:-$(dpkg --print-architecture)}"
INSTALL_USER="${SUDO_USER:-$(id -un)}"
APPARMOR_LOCAL_PROFILE="/etc/apparmor.d/local/fusermount3"
APPARMOR_RULE_MARKER="# dev-infra-manager: allow Sysbox FUSE mounts"

if [[ "$INSTALL_USER" == "root" ]]; then
  INSTALL_USER=""
fi

case "$SYSBOX_ARCH" in
  arm64)
    SYSBOX_SHA256="eae9c0e91ddd39bd1826d6a7a313a73d42a8449ef5113e9d6d118b559cb809ba"
    ;;
  amd64)
    SYSBOX_SHA256="eeff273671467b8fa351ab3d40709759462dc03d9f7b50a1b207b37982ce40a9"
    ;;
  *)
    echo "Unsupported architecture for pinned Sysbox package: $SYSBOX_ARCH" >&2
    exit 2
    ;;
esac

deb="$(mktemp --suffix=.deb "/tmp/sysbox-ce_${SYSBOX_VERSION}-0.linux_${SYSBOX_ARCH}.XXXXXX")"
trap 'rm -f -- "$deb"' EXIT
url="https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/sysbox-ce_${SYSBOX_VERSION}-0.linux_${SYSBOX_ARCH}.deb"

cat <<EOF
Ubuntu host convenience installer
=================================

This script is a development convenience, not production hardening guidance.
Review and adapt every change before using it on a production host.

It will:
  - install APT packages: curl, docker.io, jq
  - download and checksum-verify Sysbox CE ${SYSBOX_VERSION} for ${SYSBOX_ARCH}
  - install the Sysbox package from:
      ${url}
  - add a narrow AppArmor exception allowing fusermount3 to mount and unmount
    FUSE filesystems below /var/lib/sysboxfs/
  - reload AppArmor and restart Docker and Sysbox services
EOF

if [[ -n "$INSTALL_USER" ]]; then
  echo "  - permanently add user '$INSTALL_USER' to the docker group"
fi

cat <<'EOF'

The AppArmor exception reduces host protection for the listed Sysbox path.
Type yes to continue; any other input cancels installation.
EOF

read -r -p "> " confirmation
if [[ "$confirmation" != "yes" ]]; then
  echo "Installation cancelled."
  exit 1
fi

sudo apt-get update
sudo apt-get install -y curl docker.io jq

curl -L -o "$deb" "$url"
echo "${SYSBOX_SHA256}  ${deb}" | sha256sum -c -

sudo apt-get install -y "$deb"

sudo install -d -m 0755 "$(dirname -- "$APPARMOR_LOCAL_PROFILE")"
if ! sudo grep -Fqx "$APPARMOR_RULE_MARKER" "$APPARMOR_LOCAL_PROFILE" 2>/dev/null; then
  printf '%s\n' \
    '' \
    "$APPARMOR_RULE_MARKER" \
    'mount fstype=@{fuse_types} options=(nosuid,nodev) options in (ro,rw,noatime,dirsync,nodiratime,noexec,sync) -> /var/lib/sysboxfs/**/,' \
    'umount /var/lib/sysboxfs/**/,' \
    | sudo tee -a "$APPARMOR_LOCAL_PROFILE" >/dev/null
fi
sudo apparmor_parser -r /etc/apparmor.d/fusermount3

sudo systemctl daemon-reload
sudo systemctl restart docker
sudo systemctl restart sysbox

if [[ -n "$INSTALL_USER" ]]; then
  if [[ " $(id -nG "$INSTALL_USER") " != *" docker "* ]]; then
    sudo usermod -aG docker "$INSTALL_USER"
  fi

  cat <<EOF
Host install complete. User '$INSTALL_USER' belongs to the docker group.

Group membership is permanent, but the current login session must be refreshed once.
Either log out and back in, or run:

  newgrp docker

Then run:

  just doctor
EOF
else
  echo "Host install complete. Run: just doctor"
fi
