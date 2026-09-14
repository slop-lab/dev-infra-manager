#!/usr/bin/env bash

dim_apply_test_registry_mirror() {
  local project_root="$1" service="${2:-agent-dind}" mirror="${DIM_DOCKER_REGISTRY_MIRROR:-}" endpoint setup temporary mirror_host relay_script
  [[ -n "$mirror" ]] || return 0
  [[ "$mirror" =~ ^http://([A-Za-z0-9.-]+):([1-9][0-9]*)$ ]] || {
    echo "invalid DIM_DOCKER_REGISTRY_MIRROR: $mirror" >&2
    return 2
  }
  endpoint="${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
  mirror_host="${DIM_TEST_REGISTRY_MIRROR_ADDRESS:-host-gateway}"
  setup="$project_root/.dim/setup.sh"
  relay_script="$project_root/.dim/ci-registry-cache-relay.sh"
  test -f "$setup"

  cat >"$relay_script" <<'EOF'
relay_endpoint="${DIM_REGISTRY_CACHE_ENDPOINT:?DIM_REGISTRY_CACHE_ENDPOINT is required}"
case "$relay_endpoint" in
  *:*[!0-9]*|:*|*[!A-Za-z0-9.:-]*) echo "invalid DIM_REGISTRY_CACHE_ENDPOINT: $relay_endpoint" >&2; exit 2 ;;
  *:*) ;;
  *) echo "invalid DIM_REGISTRY_CACHE_ENDPOINT: $relay_endpoint" >&2; exit 2 ;;
esac
relay_host="${relay_endpoint%:*}"
relay_port="${relay_endpoint##*:}"
relay_pid_file=/tmp/dim-ci-registry-cache-relay.pid
relay_config=/tmp/dim-ci-registry-cache-relay.json
if [ -r "$relay_pid_file" ]; then
  old_relay_pid="$(cat "$relay_pid_file")"
  case "$old_relay_pid" in
    ''|*[!0-9]*) ;;
    *)
      if [ -r "/proc/$old_relay_pid/cmdline" ] &&
        tr '\000' ' ' <"/proc/$old_relay_pid/cmdline" | grep -Fq '/usr/local/lib/dim/route-relay.mjs'; then
        kill "$old_relay_pid" 2>/dev/null || true
        for attempt in $(seq 1 100); do
          kill -0 "$old_relay_pid" 2>/dev/null || break
          sleep 0.05
        done
        kill -0 "$old_relay_pid" 2>/dev/null && { echo "old workspace registry-cache relay did not stop" >&2; exit 1; }
      fi
      ;;
  esac
fi
printf '{"host":"%s","port":%s}\n' "$relay_host" "$relay_port" >"$relay_config"
node /usr/local/lib/dim/route-relay.mjs 5000 "$relay_config" >/tmp/dim-ci-registry-cache-relay.log 2>&1 &
echo "$!" >"$relay_pid_file"
relay_ready=false
for attempt in $(seq 1 100); do
  if curl --fail --silent http://127.0.0.1:5000/v2/ >/dev/null; then
    relay_ready=true
    break
  fi
  sleep 0.05
done
if [ "$relay_ready" != true ]; then
  cat /tmp/dim-ci-registry-cache-relay.log >&2
  echo "workspace registry-cache relay readiness timed out" >&2
  exit 1
fi
EOF

  cat >"$project_root/.dim/ci-registry-mirror.override.yml" <<EOF
services:
  $service:
    command:
      - --registry-mirror=$mirror
      - --insecure-registry=$endpoint
    extra_hosts:
      - "${BASH_REMATCH[1]}:$mirror_host"
      - "registry-1.docker.io:127.0.0.1"
      - "auth.docker.io:127.0.0.1"
EOF
  if ! grep -Fq 'ci-registry-mirror.override.yml' "$setup"; then
    temporary="$setup.tmp"
    sed -e '/^set -e/a . .dim/ci-registry-cache-relay.sh' \
      -e 's#--file \.dim/docker-compose\.yml#--file .dim/docker-compose.yml --file .dim/ci-registry-mirror.override.yml#g' \
      "$setup" >"$temporary"
    mv "$temporary" "$setup"
  fi
}
