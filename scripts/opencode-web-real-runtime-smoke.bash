#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-opencode-web-real.XXXXXX)"
fixture_pid=""
proxy_pid=""
server_pid=""
service_pid=""

process_start_time() {
  node - "$1" <<'NODE'
import fs from "node:fs";
const source = fs.readFileSync(`/proc/${process.argv[2]}/stat`, "utf8");
process.stdout.write(source.slice(source.lastIndexOf(")") + 2).trim().split(/\s+/)[19]);
NODE
}

stop_owned_gateway() {
  local identity_file="$work_dir/home/.local/state/dim/development-service/gateway.identity.json"
  [[ -r "$identity_file" ]] || return 0
  local gateway_pid gateway_start
  gateway_pid="$(node -e 'const value=require(process.argv[1]); process.stdout.write(String(value.pid))' "$identity_file")"
  gateway_start="$(node -e 'const value=require(process.argv[1]); process.stdout.write(value.startTime)' "$identity_file")"
  [[ -r "/proc/$gateway_pid/stat" ]] || return 0
  [[ "$(process_start_time "$gateway_pid")" = "$gateway_start" ]] || {
    printf 'refusing to stop a development gateway with mismatched identity\n' >&2
    return 1
  }
  kill "$gateway_pid"
  for _ in $(seq 1 50); do
    [[ ! -e "$identity_file" ]] && return 0
    kill -0 "$gateway_pid" 2>/dev/null || return 0
    sleep 0.1
  done
  printf 'owned development gateway did not stop\n' >&2
  return 1
}

cleanup() {
  local status=$?
  [[ -z "$server_pid" ]] || kill "$server_pid" 2>/dev/null || true
  [[ -z "$service_pid" ]] || kill "$service_pid" 2>/dev/null || true
  [[ -z "$proxy_pid" ]] || kill "$proxy_pid" 2>/dev/null || true
  [[ -z "$fixture_pid" ]] || kill "$fixture_pid" 2>/dev/null || true
  [[ -z "$server_pid" ]] || wait "$server_pid" 2>/dev/null || true
  [[ -z "$service_pid" ]] || wait "$service_pid" 2>/dev/null || true
  [[ -z "$proxy_pid" ]] || wait "$proxy_pid" 2>/dev/null || true
  [[ -z "$fixture_pid" ]] || wait "$fixture_pid" 2>/dev/null || true
  if ! stop_owned_gateway; then
    status=1
  fi
  rm -rf -- "$work_dir"
  return "$status"
}
trap cleanup EXIT

exec {gateway_lock_fd}>/tmp/dim-development-service-gateway-31887.lock
flock --wait 30 "$gateway_lock_fd"
node - <<'NODE'
import net from "node:net";
const server = net.createServer();
server.once("error", () => process.exit(1));
server.listen(31887, "127.0.0.1", () => server.close());
NODE

find_opencode() {
  local candidate
  for candidate in "${OPENCODE_REAL_BINARY:-}" "$HOME/.local/bin/opencode" "$HOME/.opencode/bin/opencode"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    [[ "$($candidate --version)" = 1.18.31 ]] && { printf '%s\n' "$candidate"; return; }
  done
  mkdir -p "$work_dir/install-home"
  HOME="$work_dir/install-home" bash "$repo_root/scripts/workspace-user-setup.bash" >/dev/null
  printf '%s\n' "$work_dir/install-home/.local/bin/opencode"
}

available_port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

pnpm --filter @slop-lab/dim-controller-proxy run build >/dev/null
chmod 0700 "$repo_root/core/packages/controller-proxy/dist/development-service-cli.js" \
  "$repo_root/core/packages/controller-proxy/dist/cli.js"
opencode_binary="$(find_opencode)"
[[ "$($opencode_binary --version)" = 1.18.31 ]]
mkdir -p "$work_dir/home" "$work_dir/tools"
ln -s "$opencode_binary" "$work_dir/tools/opencode"
ln -s "$repo_root/core/packages/controller-proxy/dist/development-service-cli.js" \
  "$work_dir/tools/dim-development-service"
ln -s "$repo_root/core/packages/controller-proxy/dist/cli.js" "$work_dir/tools/dim-controller-proxy"

opencode_port="$(available_port)"
service_port="$(available_port)"
replacement_port="$(available_port)"
external_port="$(available_port)"
source_socket="$work_dir/source.sock"
proxy_socket="$work_dir/proxy.sock"
development_socket="$work_dir/development.sock"
before_requests="$work_dir/before-requests.jsonl"
after_requests="$work_dir/after-requests.jsonl"
openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=service-1.example.test -days 1 \
  -keyout "$work_dir/key.pem" -out "$work_dir/cert.pem" >/dev/null 2>&1

node "$script_dir/opencode-web-real-runtime-fixture.mjs" "$source_socket" "$development_socket" "$proxy_socket" \
  "$external_port" "$before_requests" "$after_requests" "$work_dir/key.pem" "$work_dir/cert.pem" &
fixture_pid=$!
for attempt in $(seq 1 100); do
  [[ -S "$source_socket" && -S "$development_socket" ]] && break
  [[ "$attempt" -lt 100 ]] || { printf 'runtime fixture did not become ready\n' >&2; exit 1; }
  sleep 0.02
done

DIM_CONTROLLER_SOCKET="$source_socket" DIM_CONTROLLER_TOKEN=fixture-token \
  "$work_dir/tools/dim-controller-proxy" external-url --listen "$proxy_socket" --ingress https-ts \
  --bind-containers-json '["fixture"]' --bind-protocol http --bind-port 31887 \
  >"$work_dir/proxy.log" 2>&1 &
proxy_pid=$!
for attempt in $(seq 1 100); do
  [[ -S "$proxy_socket" ]] && break
  [[ "$attempt" -lt 100 ]] || { printf 'bound proxy did not become ready:\n' >&2; cat "$work_dir/proxy.log" >&2; exit 1; }
  sleep 0.02
done

run_launcher() {
  local selected_port="${1:-$opencode_port}"
  local selected_ingress="${2:-https-ts}"
  env -i HOME="$work_dir/home" PATH="$work_dir/tools:/usr/local/bin:/usr/bin:/bin" \
    DIM_DEVELOPMENT_URL_SOCKET="$development_socket" OPENCODE_WEB_PORT="$selected_port" \
    OPENCODE_WEB_INGRESS="$selected_ingress" \
    bash "$repo_root/scripts/opencode-web.bash"
}

first_output="$(run_launcher 2>"$work_dir/first.stderr")"
credential_file="$work_dir/home/.local/state/opencode-web/credentials"
password="$(sed -n '2p' "$credential_file")"
server_pid="$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")"
opencode_url="$(sed -n 's/^url: //p' <<<"$first_output")"
[[ "$opencode_url" = "https://service-1.example.test:$external_port" ]]
[[ "$opencode_port" != 4096 ]]
[[ "$(curl --noproxy '*' --insecure --silent --resolve "service-1.example.test:$external_port:127.0.0.1" \
  --output /dev/null --write-out '%{http_code}' "$opencode_url/global/health")" = 401 ]]
auth_config="$work_dir/curl-auth"
printf 'user = "opencode:%s"\n' "$password" >"$auth_config"
chmod 0600 "$auth_config"
[[ "$(curl --config "$auth_config" --noproxy '*' --insecure --silent \
  --resolve "service-1.example.test:$external_port:127.0.0.1" --output /dev/null \
  --write-out '%{http_code}' "$opencode_url/global/health")" = 200 ]]

cat >"$work_dir/service.mjs" <<'EOF'
import http from "node:http";
const [portText, label] = process.argv.slice(2);
const server = http.createServer((_request, response) => response.end(label));
server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello"));
server.listen(Number.parseInt(portText, 10), "127.0.0.1");
EOF
node "$work_dir/service.mjs" "$service_port" first &
service_pid=$!
for attempt in $(seq 1 100); do
  [[ "$(curl --silent "http://127.0.0.1:$service_port" || true)" = first ]] && break
  [[ "$attempt" -lt 100 ]] || { printf 'generic service did not become ready\n' >&2; exit 1; }
  sleep 0.02
done
generic_url="$(HOME="$work_dir/home" PATH="$work_dir/tools:/usr/local/bin:/usr/bin:/bin" \
  DIM_DEVELOPMENT_URL_SOCKET="$development_socket" dim-development-service expose \
  --name generic-http --port "$service_port" --ingress https-ts --require-scheme https)"
[[ "$generic_url" = "https://service-2.example.test:$external_port" ]]
[[ "$(curl --noproxy '*' --insecure --silent --resolve "service-2.example.test:$external_port:127.0.0.1" "$generic_url")" = first ]]
node - "$external_port" <<'NODE'
import tls from "node:tls";
const port = Number.parseInt(process.argv[2], 10);
const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
  socket.write(`GET /socket HTTP/1.1\r\nHost: service-2.example.test:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
});
let response = "";
socket.on("data", (chunk) => {
  response += chunk.toString("utf8");
  if (response.includes("hello")) socket.end();
});
socket.on("close", () => process.exit(response.includes("101 Switching Protocols") && response.includes("hello") ? 0 : 1));
socket.on("error", () => process.exit(1));
NODE

kill "$service_pid"
wait "$service_pid" 2>/dev/null || true
node "$work_dir/service.mjs" "$replacement_port" second &
service_pid=$!
for attempt in $(seq 1 100); do
  [[ "$(curl --silent "http://127.0.0.1:$replacement_port" || true)" = second ]] && break
  [[ "$attempt" -lt 100 ]] || { printf 'replacement service did not become ready\n' >&2; exit 1; }
  sleep 0.02
done
reused_url="$(HOME="$work_dir/home" PATH="$work_dir/tools:/usr/local/bin:/usr/bin:/bin" \
  DIM_DEVELOPMENT_URL_SOCKET="$development_socket" dim-development-service expose \
  --name generic-http --port "$replacement_port" --ingress https-ts --require-scheme https)"
[[ "$reused_url" = "$generic_url" ]]
[[ "$(curl --noproxy '*' --insecure --silent --resolve "service-2.example.test:$external_port:127.0.0.1" "$reused_url")" = second ]]

node - "$before_requests" "$after_requests" <<'NODE'
import fs from "node:fs";
const [beforeFile, afterFile] = process.argv.slice(2);
const before = fs.readFileSync(beforeFile, "utf8").trim().split("\n").map(JSON.parse);
const after = fs.readFileSync(afterFile, "utf8").trim().split("\n").map(JSON.parse);
if (before.length !== 2 || before.some((body) => JSON.stringify(body) !== '{"ingress":"https-ts"}')) process.exit(1);
const target = { containers: ["fixture"], protocol: "http", port: 31887 };
if (after.length !== 2 || after.some((body) => JSON.stringify(body.target) !== JSON.stringify(target))) process.exit(1);
NODE

second_output="$(run_launcher 2>"$work_dir/second.stderr")"
[[ "$second_output" = "$first_output" ]]
[[ "$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")" = "$server_pid" ]]
[[ "$first_output" != *"$password"* ]]
! tr '\0' '\n' <"/proc/$server_pid/cmdline" | grep -Fq "$password"
! grep -Fq "$password" "$work_dir/home/.local/state/opencode-web/server.log"
[[ "$(stat -c %a "$work_dir/home/.local/state/opencode-web")" = 700 ]]
[[ "$(stat -c %a "$credential_file")" = 600 ]]
[[ "$(stat -c %a "$work_dir/home/.local/state/opencode-web/server.pid")" = 600 ]]
[[ "$(stat -c %a "$work_dir/home/.local/state/opencode-web/server.log")" = 600 ]]
gateway_state="$work_dir/home/.local/state/dim/development-service"
gateway_identity="$gateway_state/gateway.identity.json"
gateway_pid="$(node -e 'const value=require(process.argv[1]); process.stdout.write(String(value.pid))' "$gateway_identity")"
gateway_start="$(node -e 'const value=require(process.argv[1]); process.stdout.write(value.startTime)' "$gateway_identity")"
[[ "$(stat -c %a "$gateway_state")" = 700 ]]
[[ "$(stat -c %a "$gateway_identity")" = 600 ]]
[[ "$(stat -c %a "$gateway_state/gateway.log")" = 600 ]]
[[ "$(stat -c %a "$gateway_state/services.json")" = 600 ]]

failure_port="$(available_port)"
if run_launcher "$failure_port" unavailable-ingress >"$work_dir/failure.stdout" 2>"$work_dir/failure.stderr"; then
  printf 'launcher accepted an unavailable ingress\n' >&2
  exit 1
fi
grep -Fq "external URL ingress 'unavailable-ingress' is unavailable" "$work_dir/failure.stderr"
grep -Fq 'could not expose OpenCode Web' "$work_dir/failure.stderr"
[[ ! -e "$work_dir/home/.local/state/opencode-web/server.pid" ]]
! kill -0 "$server_pid" 2>/dev/null
server_pid=""
! curl --silent --max-time 1 "http://127.0.0.1:$failure_port/global/health" >/dev/null
kill -0 "$gateway_pid"
[[ "$(process_start_time "$gateway_pid")" = "$gateway_start" ]]
[[ "$(curl --noproxy '*' --insecure --silent --resolve "service-2.example.test:$external_port:127.0.0.1" "$generic_url")" = second ]]

stop_owned_gateway
[[ ! -e "$work_dir/home/.local/state/dim/development-service/gateway.identity.json" ]]
printf '%s\n' opencode-web-real-runtime-smoke-ok
