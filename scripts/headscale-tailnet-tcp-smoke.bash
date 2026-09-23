#!/usr/bin/env bash
set -euo pipefail

headscale_image="headscale/headscale@sha256:404e3251f14f080e99093e8855a4a70062271ac7111153eb02a1f879f9f200c8"
tailscale_image="tailscale/tailscale@sha256:481044a4214e3b24d39194143d7563066b8b223765a100dc4957f762bbf7ff19"
node_image="node:24-alpine@sha256:83f1c388c31fb2e51f7cbd4dea949b96260798c98f206e8e4696bc93bd964e3a"
alpine_image="alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8"
suffix="${RANDOM}-$$"
tailnet="dim-headscale-${suffix}"
target_network="dim-tcp-target-${suffix}"
headscale="dim-headscale-${suffix}"
host="dim-tailnet-host-${suffix}"
client="dim-tailnet-client-${suffix}"
target="dim-tcp-target-${suffix}"
host_image="dim-tailnet-plugin-smoke:${suffix}"
fixture_root="$(mktemp -d)"
sentinel="dim-plugin-tcp-${suffix}"

cleanup() {
  status=$?
  if (( status != 0 )); then
    for container in "$host" "$client" "$target" "$headscale"; do
      docker logs "$container" >&2 2>/dev/null || true
    done
  fi
  docker rm --force "$client" "$host" "$target" "$headscale" >/dev/null 2>&1 || true
  docker network rm "$target_network" "$tailnet" >/dev/null 2>&1 || true
  docker image rm "$host_image" >/dev/null 2>&1 || true
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

cat >"$fixture_root/fixture.mjs" <<'JS'
import http from "node:http";
import { TcpIngressListener, tailscaleIngressDriver } from "@slop-lab/dim-plugin-external-urls";

const runtime = await tailscaleIngressDriver.runtime('{"listenPort":49152}');
const listener = new TcpIngressListener({ name: "tailnet", ...runtime });
const route = await listener.provision(
  { id: "fixture:workspace", name: "workspace", projectId: "fixture", projectName: "fixture" },
  { target: { containers: ["target"], port: 39000, protocol: "tcp" } },
  { host: "target", port: 39000, protocol: "tcp" }
);
const control = http.createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/revoke") {
    await listener.revoke(route);
    response.writeHead(204).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url: route.url }));
});
await new Promise((resolve, reject) => {
  control.once("error", reject);
  control.listen(3000, "127.0.0.1", resolve);
});
console.log(`READY ${route.url}`);

const shutdown = async () => {
  await listener.close();
  control.closeAllConnections();
  control.close(() => process.exit(0));
};
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
JS

cat >"$fixture_root/entrypoint.sh" <<'SH'
#!/bin/sh
set -eu
mkdir -p /var/run/tailscale /var/lib/tailscale
tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock >/tmp/tailscaled.log 2>&1 &
for attempt in $(seq 1 30); do
  if tailscale status >/dev/null 2>&1; then break; fi
  sleep 1
done
tailscale up --login-server=http://headscale:8080 --auth-key="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" --accept-dns=false
exec node /app/fixture.mjs
SH
chmod 0755 "$fixture_root/entrypoint.sh"

bash verification/scripts/pack-local-packages.bash "$fixture_root/packages"
cat >"$fixture_root/Dockerfile" <<DOCKERFILE
FROM ${tailscale_image} AS tailscale
FROM ${node_image}
RUN apk add --no-cache ca-certificates iptables ip6tables
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
WORKDIR /app
COPY packages /tmp/packages
RUN npm init -y >/dev/null \
 && npm install --omit=dev /tmp/packages/*.tgz >/dev/null \
 && rm -rf /tmp/packages
COPY fixture.mjs /app/fixture.mjs
COPY entrypoint.sh /usr/local/bin/dim-tailnet-fixture
ENTRYPOINT ["/usr/local/bin/dim-tailnet-fixture"]
DOCKERFILE
docker build --tag "$host_image" "$fixture_root" >/dev/null

docker network create "$tailnet" >/dev/null
docker network create "$target_network" >/dev/null
docker create --name "$headscale" --network "$tailnet" --network-alias headscale \
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

docker run --detach --name "$target" --network "$target_network" --network-alias target \
  "$alpine_image" sh -c \
  "printf '%s\n' '#!/bin/sh' 'exec cat' >/tmp/respond && chmod 0755 /tmp/respond && exec nc -lk -p 39000 -e /tmp/respond" >/dev/null
docker run --detach --name "$host" --network "$tailnet" --cap-add NET_ADMIN --device /dev/net/tun \
  --env TS_AUTHKEY="$auth_key" --env TS_HOSTNAME="$host" "$host_image" >/dev/null
docker network connect "$target_network" "$host"
docker run --detach --name "$client" --network "$tailnet" \
  --cap-add NET_ADMIN --device /dev/net/tun \
  --env TS_AUTHKEY="$auth_key" --env TS_AUTH_ONCE=true --env TS_HOSTNAME="$client" \
  --env TS_STATE_DIR=/var/lib/tailscale --env TS_USERSPACE=false \
  --env 'TS_EXTRA_ARGS=--login-server=http://headscale:8080 --accept-dns=false' \
  "$tailscale_image" >/dev/null

for _ in $(seq 1 45); do
  if docker logs "$host" 2>&1 | grep -q '^READY tcp://'; then break; fi
  sleep 1
done
endpoint="$(docker logs "$host" 2>&1 | sed -n 's/^READY tcp:\/\/\(.*\)$/\1/p' | tail -n 1)"
test -n "$endpoint"
host_ip="${endpoint%:49152}"
for _ in $(seq 1 20); do
  if docker exec "$client" tailscale ping --timeout=2s "$host_ip" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$client" tailscale ping --timeout=2s "$host_ip" >/dev/null

target_environment="$(docker inspect "$target" --format '{{json .Config.Env}} {{json .Mounts}}')"
if [[ "$target_environment" == *TS_AUTHKEY* || "$target_environment" == *tailscale* ]]; then
  echo "non-tailnet target received Tailscale state" >&2
  exit 1
fi
docker exec "$target" sh -c '! command -v tailscale && test ! -e /var/run/tailscale/tailscaled.sock'

response="$(docker exec "$client" sh -c \
  "{ printf '%s' '$sentinel'; sleep 1; } | nc -w 2 '$host_ip' 49152")"
test "$response" = "$sentinel"
docker exec "$host" node -e \
  "fetch('http://127.0.0.1:3000/revoke',{method:'POST'}).then(r=>{if(r.status!==204)process.exit(1)})"
revoked="$(docker exec "$client" sh -c \
  "{ printf revoked; sleep 1; } | nc -w 2 '$host_ip' 49152" 2>/dev/null || true)"
test -z "$revoked"
printf 'ok packaged DIM TCP ingress: %s -> non-tailnet target; revocation closed route\n' "$endpoint"
