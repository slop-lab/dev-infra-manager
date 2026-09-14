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

echo "[setup] reconcile repositories" >&2
sh .dim/reconcile-repositories.sh

echo "[setup] start controller proxy" >&2
external_url_proxy_dir=/tmp/dim-external-url
external_url_proxy_socket="$external_url_proxy_dir/controller.sock"
if ! curl --fail --silent --unix-socket "$external_url_proxy_socket" \
  http://dim-controller/api >/dev/null 2>&1; then
  if [ -r "$external_url_proxy_dir/proxy.pid" ]; then
    old_proxy_pid="$(cat "$external_url_proxy_dir/proxy.pid")"
    case "$old_proxy_pid" in
      ''|*[!0-9]*) ;;
      *) kill "$old_proxy_pid" 2>/dev/null || true ;;
    esac
  fi
  rm -rf "$external_url_proxy_dir"
  mkdir -p "$external_url_proxy_dir"
  dim-controller-proxy external-url \
    --listen "$external_url_proxy_socket" \
    --ingress https-ts \
    --ingress http-ts \
    --directory-mode 0755 \
    --socket-mode 0666 \
    >"$external_url_proxy_dir/proxy.log" 2>&1 &
  echo "$!" >"$external_url_proxy_dir/proxy.pid"
  for _ in $(seq 1 50); do
    test -S "$external_url_proxy_socket" && break
    sleep 0.1
  done
  test -S "$external_url_proxy_socket" || {
    cat "$external_url_proxy_dir/proxy.log" >&2
    exit 1
  }
fi

qemu_service_dir=/tmp/dim-qemu-verification
install -d -m 0755 "$qemu_service_dir"
qemu_process_start_time() {
  process_stat="$(cat "/proc/$1/stat")" || return 1
  process_stat="${process_stat##*) }"
  set -- $process_stat
  test "$#" -ge 20 || return 1
  shift 19
  printf '%s\n' "$1"
}
if [ "${DIM_WORKSPACE_KVM}" = 1 ]; then
  echo "[setup] start QEMU service" >&2
  qemu_pid_file="$qemu_service_dir/service.pid"
  qemu_socket="$qemu_service_dir/service.sock"
  if [ -e "$qemu_pid_file" ] || [ -L "$qemu_pid_file" ]; then
    test -f "$qemu_pid_file" && test ! -L "$qemu_pid_file" && test -r "$qemu_pid_file" || {
      echo "existing QEMU service PID record is unreadable" >&2
      exit 1
    }
    old_pid="$(cat "$qemu_service_dir/service.pid")"
    case "$old_pid" in
      ''|0*|*[!0-9]*) echo "existing QEMU service PID record is malformed" >&2; exit 1 ;;
    esac
    test "$(wc -l <"$qemu_pid_file")" -eq 1 && test "${#old_pid}" -le 7 &&
      test "$old_pid" -le "$(cat /proc/sys/kernel/pid_max)" || {
      echo "existing QEMU service PID record is malformed" >&2
      exit 1
    }
    if kill -0 "$old_pid" 2>/dev/null; then
      expected_qemu_cwd="$(pwd -P)"
      old_start_time="$(qemu_process_start_time "$old_pid")" &&
        test -r "/proc/$old_pid/cmdline" &&
        tr '\000' '\n' <"/proc/$old_pid/cmdline" | grep -Fxq '.dim/qemu-service.mjs' &&
        test "$(readlink "/proc/$old_pid/cwd")" = "$expected_qemu_cwd" &&
        test "$(qemu_process_start_time "$old_pid")" = "$old_start_time" || {
        echo "existing QEMU service PID identity is ambiguous" >&2
        exit 1
      }
      kill "$old_pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        kill -0 "$old_pid" 2>/dev/null || break
        sleep 0.1
      done
      if kill -0 "$old_pid" 2>/dev/null &&
        test "$(qemu_process_start_time "$old_pid")" = "$old_start_time"; then
        echo "existing QEMU service $old_pid did not stop" >&2
        exit 1
      fi
    elif [ -d "/proc/$old_pid" ]; then
      echo "existing QEMU service PID identity is ambiguous" >&2
      exit 1
    fi
  elif [ -e "$qemu_socket" ] || [ -L "$qemu_socket" ]; then
    echo "existing QEMU service socket has no PID record" >&2
    exit 1
  fi
  rm -f "$qemu_service_dir/service.sock" "$qemu_service_dir/service.pid"
  install -m 0500 .dim/qemu-verify.bash "$qemu_service_dir/launcher.bash"
  DIM_QEMU_SOURCE_ROOT=/workspace \
  DIM_QEMU_LAUNCHER="$qemu_service_dir/launcher.bash" \
  DIM_KVM_IMAGE_CACHE="$qemu_service_dir/cache" \
  DIM_QEMU_SERVICE_SOCKET="$qemu_service_dir/service.sock" \
    nohup node .dim/qemu-service.mjs >"$qemu_service_dir/service.log" 2>&1 &
  new_pid="$!"
  for _ in $(seq 1 50); do
    test -r "$qemu_service_dir/service.pid" &&
      test "$(cat "$qemu_service_dir/service.pid")" = "$new_pid" &&
      test -S "$qemu_service_dir/service.sock" &&
      test "$(stat -c %a "$qemu_service_dir/service.sock")" = 666 &&
      curl --fail --silent --max-time 1 --unix-socket "$qemu_service_dir/service.sock" \
        http://dim-qemu/v1/status >/dev/null 2>&1 && break
    sleep 0.1
  done
  test -r "$qemu_service_dir/service.pid" &&
    test "$(cat "$qemu_service_dir/service.pid")" = "$new_pid" &&
    test -S "$qemu_service_dir/service.sock" &&
    test "$(stat -c %a "$qemu_service_dir/service.sock")" = 666 &&
    curl --fail --silent --max-time 1 --unix-socket "$qemu_service_dir/service.sock" \
      http://dim-qemu/v1/status >/dev/null 2>&1 || {
    kill "$new_pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$new_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$new_pid" 2>/dev/null && kill -KILL "$new_pid" 2>/dev/null || true
    wait "$new_pid" 2>/dev/null || true
    rm -f "$qemu_service_dir/service.sock" "$qemu_service_dir/service.pid"
    cat "$qemu_service_dir/service.log" >&2
    exit 1
  }
else
  echo "[setup] skip QEMU service" >&2
  rm -rf "$qemu_service_dir"
  install -d -m 0755 "$qemu_service_dir"
fi

# Avoid inheriting buildx activity files created by a root lifecycle helper.
export DOCKER_CONFIG="/tmp/dim-workspace-docker-config-$(id -u)"
mkdir -p "$DOCKER_CONFIG"
chmod 0700 "$DOCKER_CONFIG"
# Compose v5's Bake path can lose setuid ownership and mode bits when BuildKit
# snapshots this image through nested overlay2. Keep the classic Compose build
# path for these security-sensitive images.
export COMPOSE_BAKE=false

compose() {
  compose_files=".dim/docker-compose.yml:$compose_host_aliases"
  if [ -r .dim/ci-registry-mirror.override.yml ]; then
    compose_files="$compose_files:.dim/ci-registry-mirror.override.yml"
  fi
  COMPOSE_FILE="$compose_files" docker compose "$@"
}

verify_idmap_helpers() {
  service="$1"
  compose exec --no-TTY --user root "$service" sh -eu -c '
    for helper in /usr/bin/newuidmap /usr/bin/newgidmap; do
      identity="$(stat -c %u:%g:%a "$helper")"
      test "$identity" = 0:0:4755 || {
        echo "$helper must be owned by root:root with mode 4755; found $identity" >&2
        exit 1
      }
    done
  '
}

echo "[setup] build and start agent runtime" >&2
compose build --quiet agent-dind
# An outer workspace stop terminates nested containers without letting their
# daemon preserve a restartable process state. Recreate Project containers on
# every setup while retaining their named data and home volumes.
compose up --detach --force-recreate --wait agent-dind
verify_idmap_helpers agent-dind
echo "[setup] configure agent and install dependencies" >&2
compose exec --no-TTY --user root agent-dind dim-agent-dind setup
case ",${COMPOSE_PROFILES:-}," in
  *,secure,*)
    echo "[setup] build and start secure runtime" >&2
    compose build --quiet secure-dind
    compose up --detach --force-recreate --wait secure-dind
    verify_idmap_helpers secure-dind
    ;;
  *)
    echo "[setup] skip secure runtime" >&2
    ;;
esac
