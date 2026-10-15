#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
pins_helper="${pins_helper:-$script_dir/../../../scripts/lib/bootstrap-ubuntu-pins.bash}"
source "$pins_helper"
key_fingerprint=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
keyring=/etc/apt/keyrings/docker.gpg
source_list=/etc/apt/sources.list.d/docker.sources

[[ "$(id -u)" == 0 ]] || { echo "Docker CE installer must run as root" >&2; exit 1; }
[[ "$(dpkg --print-architecture)" == amd64 ]] || { echo "Docker CE bootstrap supports amd64 only" >&2; exit 2; }

conflict_packages=(docker.io docker-doc docker-compose docker-compose-v2 docker-buildx podman-docker containerd runc)
for conflict_package in "${conflict_packages[@]}"; do
  if [[ "$(dpkg-query -W -f='${Status}' "$conflict_package" 2>/dev/null || true)" == "install ok installed" ]]; then
    echo "refusing pre-existing conflicting Docker package: $conflict_package" >&2
    exit 2
  fi
done

apt-get update
apt-get install -y ca-certificates curl gnupg
work="$(mktemp -d /tmp/dim-docker-ce.XXXXXX)"
trap 'rm -rf -- "$work"' EXIT
curl --fail --silent --show-error --location --output "$work/docker.asc" \
  https://download.docker.com/linux/ubuntu/gpg
actual_fingerprint="$(gpg --batch --show-keys --with-colons "$work/docker.asc" | awk -F: '$1=="fpr" {print $10; exit}')"
[[ "$actual_fingerprint" == "$key_fingerprint" ]] || {
  echo "Docker APT key fingerprint mismatch" >&2
  exit 1
}
gpg --batch --dearmor --output "$work/docker.gpg" "$work/docker.asc"
install -d -m 0755 /etc/apt/keyrings
if [[ -e "$keyring" || -L "$keyring" ]]; then
  [[ ! -L "$keyring" && -f "$keyring" ]] || { echo "refusing unsafe Docker keyring target" >&2; exit 1; }
  installed_fingerprint="$(gpg --batch --show-keys --with-colons "$keyring" | awk -F: '$1=="fpr" {print $10; exit}')"
  [[ "$installed_fingerprint" == "$key_fingerprint" ]] || { echo "refusing foreign Docker keyring" >&2; exit 1; }
else
  install -m 0644 "$work/docker.gpg" "$keyring"
fi

cat >"$work/docker.sources" <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: $keyring
EOF
if [[ -e "$source_list" || -L "$source_list" ]]; then
  [[ ! -L "$source_list" && -f "$source_list" ]] && cmp -s "$work/docker.sources" "$source_list" || {
    echo "refusing foreign Docker APT source configuration" >&2
    exit 1
  }
else
  install -m 0644 "$work/docker.sources" "$source_list"
fi

apt-get update
apt-get install -y \
  "docker-ce=$dim_docker_package_version" \
  "docker-ce-cli=$dim_docker_package_version" \
  "containerd.io=$dim_containerd_package_version" \
  "docker-buildx-plugin=$dim_buildx_package_version" \
  "docker-compose-plugin=$dim_compose_package_version"
apt-mark hold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
for package_version in \
  "docker-ce:$dim_docker_package_version" "docker-ce-cli:$dim_docker_package_version" "containerd.io:$dim_containerd_package_version" \
  "docker-buildx-plugin:$dim_buildx_package_version" "docker-compose-plugin:$dim_compose_package_version"; do
  package="${package_version%%:*}"
  expected="${package_version#*:}"
  [[ "$(dpkg-query -W -f='${Version}' "$package")" == "$expected" ]] || {
    echo "installed Docker package version mismatch: $package" >&2
    exit 1
  }
done
systemctl enable --now docker
docker info --format '{{json .DriverStatus}}' | grep -Fq io.containerd.snapshotter.v1 || {
  echo "Docker containerd image store is not active; refusing a daemon override or data migration" >&2
  exit 1
}
