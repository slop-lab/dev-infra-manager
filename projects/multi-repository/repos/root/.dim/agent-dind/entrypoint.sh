#!/bin/sh
set -eu

chown root:root /usr/bin/newuidmap /usr/bin/newgidmap
chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

runtime_dir=/run/dim-agent-dind
docker_data=/home/rootless/.local/share/docker
mkdir -p "$runtime_dir" "$docker_data" /mnt/agent-home /mnt/workspace-shared-dind
rootless_owner="$(id -u rootless):$(id -g rootless)"

prepare_persistent_root() {
  path="$1"
  required_mode="$2"
  label="$3"
  actual_owner="$(stat -c %u:%g "$path")"
  actual_mode="$(stat -c %a "$path")"
  if [ "$actual_owner" = "$rootless_owner" ] &&
    { [ -z "$required_mode" ] || [ "$actual_mode" = "$required_mode" ]; }; then
    return
  fi
  if [ -n "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "$label has incompatible ownership or mode: expected $rootless_owner${required_mode:+ mode $required_mode}, found $actual_owner mode $actual_mode" >&2
    exit 1
  fi
  chown "$rootless_owner" "$path"
  if [ -n "$required_mode" ]; then
    chmod "$required_mode" "$path"
  fi
}

prepare_persistent_root "$docker_data" "" "agent Docker data"
prepare_persistent_root /mnt/agent-home 700 "agent home"
chown rootless:rootless "$runtime_dir"
chmod 0700 "$runtime_dir"
chmod 1777 /mnt/workspace-shared-dind

socat TCP-LISTEN:7099,reuseaddr,fork TCP:secure-dind:7099 &

exec su-exec rootless env \
  HOME=/home/rootless \
  XDG_RUNTIME_DIR="$runtime_dir" \
  DOCKER_HOST="unix://$runtime_dir/docker.sock" \
  dockerd-entrypoint.sh dockerd --host="unix://$runtime_dir/docker.sock"
