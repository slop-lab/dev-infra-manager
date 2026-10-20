#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
pins_helper="${pins_helper:-$script_dir/../../lib/bootstrap-ubuntu-pins.bash}"
source "$pins_helper"
version="$dim_node_version"
target="$dim_node_root"
archive_arch="${1:-}"
dim_bootstrap_artifact node "$archive_arch"
checksum="$dim_artifact_sha256"
url="$dim_artifact_url"

if [[ "${2:-}" == --describe ]]; then
  printf '  - download: %s\n  - SHA-256: %s\n  - install Node executable: %s/bin/node\n' \
    "$url" "$checksum" "$target"
  exit 0
fi

[[ "$(/usr/bin/id -u)" == 0 ]] || {
  echo "trusted QEMU Node installer must run as root" >&2
  exit 1
}

validate_ancestor_chain() {
  local component="$1" metadata mode
  while true; do
    if [[ -L "$component" || ! -d "$component" ]]; then
      printf 'trusted Node.js ancestor must be a real directory: %s\n' "$component" >&2
      return 1
    fi
    metadata="$(/usr/bin/stat -c '%u:%a' -- "$component")"
    mode="${metadata#*:}"
    if [[ "${metadata%%:*}" != 0 ]] || (( (8#$mode & 8#022) != 0 )); then
      printf 'trusted Node.js ancestor must be root-owned and not group/world-writable: %s\n' "$component" >&2
      return 1
    fi
    [[ "$component" == / ]] && break
    component="$(/usr/bin/dirname -- "$component")"
  done
}

validate_install() {
  local install_root="$1" node="$1/bin/node"
  if [[ -L "$install_root" || ! -d "$install_root" ]] ||
    [[ -L "$node" || ! -f "$node" || ! -x "$node" ]]; then
    printf 'refusing unsafe or foreign trusted Node target: %s\n' "$install_root" >&2
    return 1
  fi
  validate_ancestor_chain "$(/usr/bin/dirname -- "$node")" || return 1
  if [[ "$(/usr/bin/readlink -f -- "$node")" != "$node" ]] ||
    [[ "$(/usr/bin/stat -c '%u:%g:%a' -- "$node")" != 0:0:755 ]] ||
    [[ "$($node --version 2>/dev/null)" != "v$version" ]]; then
    printf 'refusing unsafe or foreign trusted Node target: %s\n' "$install_root" >&2
    return 1
  fi
}

if [[ -e "$target" || -L "$target" ]]; then
  validate_install "$target"
  printf 'Pinned trusted Node.js v%s is already installed at %s/bin/node\n' "$version" "$target"
  exit 0
fi

validate_ancestor_chain /usr/local/lib
umask 077
work="$(/usr/bin/mktemp -d /usr/local/lib/.dim-qemu-node-install.XXXXXX)"
trap '/usr/bin/rm -rf -- "$work"' EXIT
archive="$work/node.tar.xz"
stage="$work/extracted"
download_helper="${download_helper:-$script_dir/bootstrap-download.bash}"
source "$download_helper"
dim_bootstrap_download "$url" "$checksum" "$archive"
[[ ! -L "$archive" && -f "$archive" ]] &&
  [[ "$(/usr/bin/stat -c '%u:%g' -- "$archive")" == 0:0 ]] || {
    echo "downloaded Node.js archive is not a root-owned regular file" >&2
    exit 1
  }
printf '%s  %s\n' "$checksum" "$archive" | /usr/bin/sha256sum --check --status
/usr/bin/mkdir -- "$stage"
/usr/bin/tar -xf "$archive" -C "$stage" --strip-components=1 --no-same-owner
/usr/bin/chown -R root:root -- "$stage"
/usr/bin/chmod -R go-w -- "$stage"
/usr/bin/chmod 0755 -- "$stage" "$stage/bin" "$stage/bin/node"
validate_install "$stage"
/usr/bin/mv -T --no-clobber -- "$stage" "$target"
if [[ -e "$stage" || -L "$stage" ]]; then
  printf 'trusted Node target appeared during installation and was preserved: %s\n' "$target" >&2
  exit 1
fi
validate_install "$target"
printf 'Installed pinned trusted Node.js v%s at %s/bin/node\n' "$version" "$target"
