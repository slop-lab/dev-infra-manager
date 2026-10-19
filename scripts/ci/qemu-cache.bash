#!/usr/bin/env bash
set -euo pipefail

cache_directory="${1:?QEMU cache directory is required}"
image=noble-server-cloudimg-amd64.img
checksum=6e40c07ae715f744f84af0bec76415cc1987dd115b4b8de437818561f01a3733

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repository_root/packages/host/plugins/vm/scripts/artifact-cache.bash"
cached="$(dim_artifact_cache "https://cloud-images.ubuntu.com/releases/noble/release-20260814/ubuntu-24.04-server-cloudimg-amd64.img" "$checksum")"
install -d -m 0755 "$cache_directory"
install -m 0444 "$cached" "$cache_directory/$image"
