#!/usr/bin/env bash
set -euo pipefail

headscale_image="headscale/headscale@sha256:404e3251f14f080e99093e8855a4a70062271ac7111153eb02a1f879f9f200c8"
tailscale_image="tailscale/tailscale@sha256:481044a4214e3b24d39194143d7563066b8b223765a100dc4957f762bbf7ff19"
suffix="${RANDOM}-$$"
network="dim-headscale-${suffix}"
headscale="dim-headscale-${suffix}"
server="dim-tailnet-server-${suffix}"
client="dim-tailnet-client-${suffix}"
fixture_root="$(mktemp -d)"
sentinel="dim-tailnet-tcp-${suffix}"

cleanup() {
  status=$?
  if (( status != 0 )) && docker inspect "$headscale" >/dev/null 2>&1; then
    docker logs "$headscale" >&2 || true
  fi
  docker rm --force "$client" "$server" "$headscale" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$fixture_root"
  return "$status"
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null || { echo "headscale-tailnet-tcp requires Docker" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "headscale-tailnet-tcp requires a reachable Docker daemon" >&2; exit 2; }

cat >"$fixture_root/config.yaml" <<'YAML'
server_url: http://headscale:8080
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 0.0.0.0:9090
grpc_listen_addr: 0.0.0.0:50443
grpc_allow_insecure: false
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  paths: []
  auto_update_enabled: false
disable_check_updates: true
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true
policy:
  mode: file
  path: ""
dns:
  magic_dns: false
  base_domain: tailnet.test
  override_local_dns: false
  nameservers:
    global: []
    split: {}
  search_domains: []
  extra_records: []
unix_socket: /var/run/headscale/headscale.sock
unix_socket_permission: "0770"
log:
  format: text
  level: info
logtail:
  enabled: false
randomize_client_port: false
YAML

docker network create "$network" >/dev/null
docker create --name "$headscale" --network "$network" --network-alias headscale \
  "$headscale_image" --config /config.yaml serve >/dev/null
docker cp "$fixture_root/config.yaml" "$headscale:/config.yaml"
docker start "$headscale" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$headscale" headscale users list >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$headscale" headscale users list >/dev/null
docker exec "$headscale" headscale users create dim >/dev/null
auth_key="$(docker exec "$headscale" headscale preauthkeys create --user 1 --reusable --expiration 1h --output json \
  | sed -n 's/.*"key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
test -n "$auth_key"

start_node() {
  local name="$1"
  docker run --detach --name "$name" --network "$network" \
    --cap-add NET_ADMIN --device /dev/net/tun \
    --env TS_AUTHKEY="$auth_key" \
    --env TS_AUTH_ONCE=true \
    --env TS_HOSTNAME="$name" \
    --env TS_STATE_DIR=/var/lib/tailscale \
    --env TS_USERSPACE=false \
    --env 'TS_EXTRA_ARGS=--login-server=http://headscale:8080 --accept-dns=false' \
    "$tailscale_image" >/dev/null
}

start_node "$server"
start_node "$client"
for node in "$server" "$client"; do
  for _ in $(seq 1 30); do
    if docker exec "$node" tailscale status --json 2>/dev/null | grep -q '"BackendState": "Running"'; then break; fi
    sleep 1
  done
  docker exec "$node" tailscale status --json | grep -q '"BackendState": "Running"'
done

server_ip="$(docker exec "$server" tailscale ip -4)"
case "$server_ip" in
  100.*) ;;
  *) echo "Headscale allocated disallowed address: $server_ip" >&2; exit 1 ;;
esac

peer_ready=false
for _ in $(seq 1 20); do
  if docker exec "$client" tailscale ping --timeout=2s "$server_ip" >/dev/null 2>&1; then
    peer_ready=true
    break
  fi
  sleep 1
done
if [[ "$peer_ready" != true ]]; then
  echo "tailnet peers did not become reachable" >&2
  docker exec "$client" tailscale status >&2 || true
  exit 1
fi

docker exec "$server" sh -c \
  "printf '%s\n' '#!/bin/sh' \"printf '%s' '$sentinel'\" >/tmp/respond && chmod 0755 /tmp/respond"
docker exec --detach "$server" nc -lk -p 49152 -s "$server_ip" -e /tmp/respond
for _ in $(seq 1 20); do
  response="$(docker exec "$client" nc -w 2 "$server_ip" 49152 2>/dev/null || true)"
  if [[ "$response" == "$sentinel" ]]; then
    printf 'ok isolated tailnet TCP: %s:49152\n' "$server_ip"
    exit 0
  fi
  sleep 1
done

echo "tailnet client did not receive the TCP sentinel" >&2
exit 1
