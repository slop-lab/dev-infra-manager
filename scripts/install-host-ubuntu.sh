#!/usr/bin/env bash
set -euo pipefail

SYSBOX_VERSION="${SYSBOX_VERSION:-0.7.0}"
SYSBOX_ARCH="${SYSBOX_ARCH:-$(dpkg --print-architecture)}"

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

deb="/tmp/sysbox-ce_${SYSBOX_VERSION}-0.linux_${SYSBOX_ARCH}.deb"
url="https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/sysbox-ce_${SYSBOX_VERSION}-0.linux_${SYSBOX_ARCH}.deb"

sudo apt-get update
sudo apt-get install -y curl docker.io jq

curl -L -o "$deb" "$url"
echo "${SYSBOX_SHA256}  ${deb}" | sha256sum -c -

sudo apt-get install -y "$deb"
sudo systemctl daemon-reload
sudo systemctl restart docker
sudo systemctl start sysbox

echo "Host install complete. Run: just doctor"
