#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node_installer="$script_dir/install-trusted-qemu-node.bash"
pins_helper="${pins_helper:-$script_dir/../../../scripts/lib/bootstrap-ubuntu-pins.bash}"
source "$pins_helper"
target="$dim_source_tools_root"

[[ "$(/usr/bin/id -u)" == 0 ]] || {
  echo "source tool installer must run as root" >&2
  exit 1
}
[[ "$(dpkg --print-architecture)" == amd64 ]] || {
  echo "source tools support Ubuntu amd64 only" >&2
  exit 2
}

apt-get update
apt-get install -y ca-certificates curl git openssh-client xz-utils
/usr/bin/bash "$node_installer" x64

validate_target() {
  [[ ! -L "$target" && -d "$target" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' -- "$target")" == 0:0:755 ]] || return 1
  [[ ! -L "$target/bin" && -d "$target/bin" && "$(stat -c '%u:%g:%a' -- "$target/bin")" == 0:0:755 ]] || return 1
  for tool in pnpm just; do
    [[ ! -L "$target/bin/$tool" && -x "$target/bin/$tool" ]] || return 1
    [[ "$(stat -c '%u:%g:%a' -- "$target/bin/$tool")" == 0:0:755 ]] || return 1
  done
  [[ "$($target/bin/pnpm --version)" == "$dim_pnpm_version" ]] &&
  [[ "$($target/bin/just --version)" == "just $dim_just_version" ]]
}

if [[ -e "$target" || -L "$target" ]]; then
  validate_target || {
    echo "refusing unsafe or foreign source tool target: $target" >&2
    exit 1
  }
  echo "Pinned source tools are already installed at $target/bin"
  exit 0
fi

work="$(mktemp -d /usr/local/lib/.dim-source-tools.XXXXXX)"
trap '/usr/bin/rm -rf -- "$work"' EXIT
mkdir -m 0755 "$work/stage" "$work/stage/bin"
source "${download_helper:-$script_dir/bootstrap-download.bash}"
dim_bootstrap_artifact pnpm amd64
dim_bootstrap_download "$dim_artifact_url" "$dim_artifact_sha256" "$work/pnpm"
dim_bootstrap_artifact just amd64
dim_bootstrap_download "$dim_artifact_url" "$dim_artifact_sha256" "$work/just.tar.gz"
tar -xzf "$work/just.tar.gz" -C "$work/stage/bin" just
install -m 0755 "$work/pnpm" "$work/stage/bin/pnpm"
chown -R root:root "$work/stage"
mv -T --no-clobber "$work/stage" "$target"
validate_target || {
  echo "installed source tool target failed validation: $target" >&2
  exit 1
}
echo "Installed Node.js $dim_node_version, pnpm $dim_pnpm_version, and Just $dim_just_version"
