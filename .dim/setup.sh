#!/usr/bin/env sh
set -eu

if [ -n "${DIM_PROJECT_MANIFEST:-}" ]; then
  test -r "$DIM_PROJECT_MANIFEST"
  test -n "${DIM_GIT_BASE_URL:-}"
  test "$(jq -r '.gitBaseUrl' "$DIM_PROJECT_MANIFEST")" = "$DIM_GIT_BASE_URL"
  test "$(jq -r '.root.path' "$DIM_PROJECT_MANIFEST")" = "${DIM_PROJECT_ROOT:-$PWD}"
fi

compose_host_aliases=/tmp/dim-project-compose-host-aliases.json
jq -e '.hostAliases | type == "object"' "$DIM_PROJECT_MANIFEST" >/dev/null
jq '{services:{"agent-dind":{extra_hosts:[.hostAliases | to_entries[] | .key as $host | .value[] | "\($host)=\(.)"]}}}' \
  "$DIM_PROJECT_MANIFEST" > "$compose_host_aliases"

case "${DIM_WORKSPACE_KVM:-}" in
  1)
    test -r /dev/kvm
    test -w /dev/kvm
    ;;
  0)
    test ! -e /dev/kvm
    ;;
  *)
    echo "DIM_WORKSPACE_KVM must be 0 or 1" >&2
    exit 2
    ;;
esac

git_name="$(dim-host-input builtin.git-author name)"
git_email="$(dim-host-input builtin.git-author email)"
DIM_WORKSPACE_UID="$(stat -c %u /workspace)"
DIM_WORKSPACE_GID="$(stat -c %g /workspace)"
test "$DIM_WORKSPACE_UID" -ne 0 || {
  echo "canonical agent-dind requires a non-root workspace owner" >&2
  exit 1
}

export GIT_AUTHOR_NAME="$git_name"
export GIT_AUTHOR_EMAIL="$git_email"
export GIT_COMMITTER_NAME="$git_name"
export GIT_COMMITTER_EMAIL="$git_email"
export DIM_WORKSPACE_UID DIM_WORKSPACE_GID

sh .dim/reconcile-repositories.sh

qemu_service_dir=/tmp/dim-qemu-verification
if [ "${DIM_WORKSPACE_KVM}" = 1 ]; then
  mkdir -p "$qemu_service_dir"
  if [ -r "$qemu_service_dir/service.pid" ]; then
    old_pid="$(cat "$qemu_service_dir/service.pid")"
    case "$old_pid" in
      *[!0-9]*|'') ;;
      *)
        if [ -r "/proc/$old_pid/cmdline" ] &&
          tr '\000' ' ' <"/proc/$old_pid/cmdline" | grep -Fq '.dim/qemu-service.mjs'; then
          kill "$old_pid" 2>/dev/null || true
          for _ in $(seq 1 50); do
            kill -0 "$old_pid" 2>/dev/null || break
            sleep 0.1
          done
        fi
        ;;
    esac
  fi
  rm -f "$qemu_service_dir/service.sock" "$qemu_service_dir/service.pid"
  install -m 0500 .dim/qemu-verify.bash "$qemu_service_dir/launcher.bash"
  DIM_QEMU_SOURCE_ROOT=/workspace \
  DIM_QEMU_LAUNCHER="$qemu_service_dir/launcher.bash" \
  DIM_KVM_IMAGE_CACHE="$qemu_service_dir/cache" \
  DIM_QEMU_SERVICE_SOCKET="$qemu_service_dir/service.sock" \
    nohup node .dim/qemu-service.mjs >"$qemu_service_dir/service.log" 2>&1 &
  for _ in $(seq 1 50); do
    test -S "$qemu_service_dir/service.sock" && break
    sleep 0.1
  done
  test -S "$qemu_service_dir/service.sock" || {
    cat "$qemu_service_dir/service.log" >&2
    exit 1
  }
else
  rm -rf "$qemu_service_dir"
  mkdir -p "$qemu_service_dir"
fi

# Avoid inheriting buildx activity files created by a root lifecycle helper.
export DOCKER_CONFIG="/tmp/dim-workspace-docker-config-$(id -u)"
mkdir -p "$DOCKER_CONFIG"
chmod 0700 "$DOCKER_CONFIG"

compose() {
  compose_files=".dim/docker-compose.yml:$compose_host_aliases"
  if [ -r .dim/ci-registry-mirror.override.yml ]; then
    compose_files="$compose_files:.dim/ci-registry-mirror.override.yml"
  fi
  COMPOSE_FILE="$compose_files" docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" "$@"
}
compose build --quiet agent-dind
# An outer workspace stop terminates nested containers without letting their
# daemon preserve a restartable process state. Recreate Project containers on
# every setup while retaining their named data and home volumes.
compose up --detach --force-recreate --wait agent-dind
compose exec --no-TTY --user root agent-dind dim-agent-dind setup
case ",${COMPOSE_PROFILES:-}," in
  *,secure,*)
    compose build --quiet secure-dind
    compose up --detach --force-recreate --wait secure-dind
    ;;
esac
