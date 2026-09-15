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
qemu_project_root="$(pwd -P)"
qemu_node=/usr/bin/node
qemu_owner_script="$qemu_project_root/.dim/qemu-service-owner.mjs"
qemu_service_script="$qemu_project_root/.dim/qemu-service.mjs"
qemu_root_owner() {
  sudo -n /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
    "$qemu_node" "$qemu_owner_script" "$@"
}
if [ -e "$qemu_service_dir/service.pid" ] || [ -L "$qemu_service_dir/service.pid" ]; then
  echo "obsolete QEMU service.pid is not accepted" >&2
  exit 1
fi
if [ "${DIM_WORKSPACE_KVM}" = 1 ]; then
  echo "[setup] start QEMU service" >&2
  sudo -n /usr/bin/install -d -o root -g root -m 0755 "$qemu_service_dir"
  qemu_owner_file="$qemu_service_dir/service-owner.json"
  qemu_socket="$qemu_service_dir/service.sock"
  qemu_lease="$qemu_service_dir/.service.sock.lease"
  qemu_root_owner retire \
    "$qemu_owner_file" "$qemu_socket" "$(pwd -P)" 5000
  sudo -n /usr/bin/install -o root -g root -m 0500 \
    "$qemu_project_root/.dim/qemu-verify.bash" "$qemu_service_dir/launcher.bash"
  sudo -n /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
    DIM_QEMU_SOURCE_ROOT=/workspace DIM_QEMU_LAUNCHER="$qemu_service_dir/launcher.bash" \
    DIM_KVM_IMAGE_CACHE="$qemu_service_dir/cache" DIM_QEMU_SERVICE_SOCKET="$qemu_socket" \
    /bin/sh -c '
    exec /usr/bin/nohup "$4" "$5" >"$6" 2>&1
  ' qemu-service "$qemu_service_dir/launcher.bash" "$qemu_service_dir/cache" \
    "$qemu_socket" "$qemu_node" "$qemu_service_script" "$qemu_service_dir/service.log" &
  service_wrapper_pid="$!"
  fingerprint=
  owned_fingerprint=
  for _ in $(seq 1 50); do
    candidate="$(qemu_root_owner inspect "$qemu_owner_file" "$qemu_socket" "$(pwd -P)" 2>/dev/null)" || candidate=
    owner_pid="$(printf '%s' "$candidate" | "$qemu_node" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s);if(v.state!=="live"||typeof v.pid!=="string")process.exit(1);process.stdout.write(v.pid)})' 2>/dev/null)" || owner_pid=
    if test -n "$owner_pid" && test "$(ps -o uid= -p "$owner_pid" | tr -d ' ')" = 0 &&
      test "$(stat -c %u:%g:%a "$qemu_owner_file")" = 0:0:600 &&
      test "$(stat -c %u:%g:%a "$qemu_socket")" = 0:0:666 &&
      test "$(stat -c %u:%g:%a "$qemu_lease")" = 0:0:666; then
      owned_fingerprint="$candidate"
      if curl --fail --silent --max-time 1 --unix-socket "$qemu_service_dir/service.sock" \
        http://dim-qemu/v1/status >/dev/null 2>&1; then fingerprint="$candidate"; break; fi
    fi
    sleep 0.1
  done
  current="$(qemu_root_owner inspect "$qemu_owner_file" "$qemu_socket" "$(pwd -P)" 2>/dev/null)" || current=
  test -n "$fingerprint" && test "$current" = "$fingerprint" || {
    if [ -n "$owned_fingerprint" ]; then
      qemu_root_owner retire-exact \
        "$qemu_owner_file" "$qemu_socket" "$(pwd -P)" 5000 "$owned_fingerprint"
    elif [ ! -e "$qemu_owner_file" ] && [ ! -L "$qemu_owner_file" ]; then
      for _ in $(seq 1 50); do
        kill -0 "$service_wrapper_pid" 2>/dev/null || {
          wait "$service_wrapper_pid" 2>/dev/null || true
          break
        }
        sleep 0.1
      done
      if kill -0 "$service_wrapper_pid" 2>/dev/null; then
        echo "QEMU service wrapper $service_wrapper_pid remained live without publishing $qemu_owner_file; refusing to signal an unowned process" >&2
      fi
    fi
    cat "$qemu_service_dir/service.log" >&2
    exit 1
  }
else
  echo "[setup] skip QEMU service" >&2
  sudo -n /usr/bin/install -d -o root -g root -m 0755 "$qemu_service_dir"
  qemu_root_owner retire "$qemu_service_dir/service-owner.json" \
    "$qemu_service_dir/service.sock" "$(pwd -P)" 5000
  sudo -n /usr/bin/rm -rf "$qemu_service_dir"
  sudo -n /usr/bin/install -d -o root -g root -m 0755 "$qemu_service_dir"
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
