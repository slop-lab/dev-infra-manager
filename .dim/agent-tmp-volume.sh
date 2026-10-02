#!/usr/bin/env sh
set -eu

action="${1:?agent temporary volume action is required}"
agent_dind_id="${2:?agent-dind container ID is required}"
project="${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"

case "$action" in
  prepare|discard) ;;
  *)
    echo "unknown agent temporary volume action: $action" >&2
    exit 2
    ;;
esac

tmp_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/mnt/agent-tmp"}}{{.Type}}|{{.Name}}{{println}}{{end}}{{end}}' "$agent_dind_id")"
home_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/mnt/agent-home"}}{{.Type}}|{{.Name}}{{println}}{{end}}{{end}}' "$agent_dind_id")"
container_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$agent_dind_id")"

tmp_type="${tmp_mount%%|*}"
tmp_volume="${tmp_mount#*|}"
home_type="${home_mount%%|*}"
home_volume="${home_mount#*|}"
test "$(printf '%s\n' "$tmp_mount" | wc -l)" -eq 1 &&
  test -n "$tmp_volume" && test "$tmp_type" = volume || {
  echo "agent temporary storage must be one volume mounted at /mnt/agent-tmp" >&2
  exit 1
}
test "$(printf '%s\n' "$home_mount" | wc -l)" -eq 1 &&
  test -n "$home_volume" && test "$home_type" = volume || {
  echo "agent home must be one volume mounted at /mnt/agent-home" >&2
  exit 1
}
test "$tmp_volume" != "$home_volume" || {
  echo "agent temporary storage must not alias the agent home volume" >&2
  exit 1
}
test "$container_project" = "$project" || {
  echo "agent-dind does not belong to Compose project $project" >&2
  exit 1
}

volume_metadata="$(docker volume inspect --format '{{.Driver}}|{{json .Options}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}|{{index .Labels "dev.dim.role"}}' "$tmp_volume")"
old_ifs="$IFS"
IFS='|' read -r volume_driver volume_options volume_project volume_logical_name volume_role <<EOF
$volume_metadata
EOF
IFS="$old_ifs"
test "$volume_driver" = local || {
  echo "agent temporary volume must use the local driver" >&2
  exit 1
}
test "$volume_options" = null || {
  echo "agent temporary volume must not use driver options" >&2
  exit 1
}
test "$volume_project" = "$project" &&
  test "$volume_logical_name" = agent-tmp &&
  test "$volume_role" = agent-tmp || {
  echo "agent temporary volume does not have exact Project ownership metadata" >&2
  exit 1
}

if [ "$action" = discard ]; then
  docker rm --force "$agent_dind_id" >/dev/null
  docker volume rm "$tmp_volume" >/dev/null
fi
