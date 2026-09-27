#!/usr/bin/env bash
set -euo pipefail

cache_directory="${1:?QEMU cache directory is required}"
image=noble-server-cloudimg-amd64.img
checksum=6e40c07ae715f744f84af0bec76415cc1987dd115b4b8de437818561f01a3733

install -d -m 0755 "$cache_directory"
if echo "$checksum  $cache_directory/$image" | sha256sum --check --status; then
  exit 0
fi
curl -fsSLo "$cache_directory/$image.tmp" \
  "https://cloud-images.ubuntu.com/noble/current/$image"
echo "$checksum  $cache_directory/$image.tmp" | sha256sum --check
mv "$cache_directory/$image.tmp" "$cache_directory/$image"
chmod 0444 "$cache_directory/$image"
