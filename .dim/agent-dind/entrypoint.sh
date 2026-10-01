#!/bin/sh
set -eu

chown root:root /usr/bin/newuidmap /usr/bin/newgidmap
chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

runtime_dir="/run/user/$(id -u rootless)"
docker_data=/home/rootless/.local/share/docker
mkdir -p "$runtime_dir" "$docker_data" /mnt/agent-home /mnt/workspace-shared-dind
rootless_owner="$(id -u rootless):$(id -g rootless)"
subuid_start="$(awk -F: '$1 == "rootless" { print $2; exit }' /etc/subuid)"
subuid_count="$(awk -F: '$1 == "rootless" { print $3; exit }' /etc/subuid)"
subgid_start="$(awk -F: '$1 == "rootless" { print $2; exit }' /etc/subgid)"
subgid_count="$(awk -F: '$1 == "rootless" { print $3; exit }' /etc/subgid)"
test -n "$subuid_start" && test -n "$subuid_count"
test -n "$subgid_start" && test -n "$subgid_count"
test "$DIM_AGENT_UID" -ge 1 && test "$DIM_AGENT_UID" -le "$subuid_count"
test "$DIM_AGENT_UID" -le "$subgid_count"
mapped_agent_uid=$((subuid_start + DIM_AGENT_UID - 1))
mapped_agent_gid=$((subgid_start + DIM_AGENT_UID - 1))
mapped_agent_owner="$mapped_agent_uid:$mapped_agent_gid"

prepare_persistent_root() {
  path="$1"
  expected_owner="$2"
  required_mode="$3"
  label="$4"
  actual_owner="$(stat -c %u:%g "$path")"
  actual_mode="$(stat -c %a "$path")"
  if [ "$actual_owner" = "$expected_owner" ] &&
    { [ -z "$required_mode" ] || [ "$actual_mode" = "$required_mode" ]; }; then
    return
  fi
  if [ -n "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "$label has incompatible ownership or mode: expected $expected_owner${required_mode:+ mode $required_mode}, found $actual_owner mode $actual_mode" >&2
    exit 1
  fi
  chown "$expected_owner" "$path"
  if [ -n "$required_mode" ]; then
    chmod "$required_mode" "$path"
  fi
}

prepare_persistent_root "$docker_data" "$rootless_owner" "" "agent Docker data"
prepare_persistent_root /mnt/agent-home "$mapped_agent_owner" 700 "agent home"
chown rootless:rootless "$runtime_dir"
chmod 0700 "$runtime_dir"
chmod 1777 /mnt/workspace-shared-dind

exec su-exec rootless env \
  HOME=/home/rootless \
  XDG_RUNTIME_DIR="$runtime_dir" \
  DOCKER_HOST="unix://$runtime_dir/docker.sock" \
  dockerd-entrypoint.sh dockerd --host="unix://$runtime_dir/docker.sock"
