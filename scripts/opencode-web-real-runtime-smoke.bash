#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-opencode-web-real.XXXXXX)"
controller_pid=""
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$server_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  [[ -z "$controller_pid" ]] || kill "$controller_pid" 2>/dev/null || true
  [[ -z "$controller_pid" ]] || wait "$controller_pid" 2>/dev/null || true
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

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

opencode_binary="$(find_opencode)"
[[ "$($opencode_binary --version)" = 1.18.31 ]]
mkdir -p "$work_dir/home" "$work_dir/tools"
ln -s "$opencode_binary" "$work_dir/tools/opencode"
port="$(available_port)"
external_port="$(available_port)"
socket="$work_dir/controller.sock"
openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=127.0.0.1 -days 1 \
  -keyout "$work_dir/key.pem" -out "$work_dir/cert.pem" >/dev/null 2>&1

cat >"$work_dir/controller.mjs" <<'EOF'
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const [socket, targetPortText, externalPortText, keyFile, certFile] = process.argv.slice(2);
const targetPort = Number.parseInt(targetPortText, 10);
const externalPort = Number.parseInt(externalPortText, 10);
const externalUrl = `https://127.0.0.1:${externalPort}`;
let created = false;
try { fs.unlinkSync(socket); } catch (error) { if (error.code !== "ENOENT") throw error; }
http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.method === "GET" && request.url === "/api") {
    response.end(JSON.stringify({ routes: [{ discovery: { ingresses: [{ name: "https-ts", scheme: "https" }] } }] }));
  } else if (request.method === "GET" && request.url === "/api/urls") {
    response.end(JSON.stringify({ urls: created ? [{ ingress: "https-ts", url: externalUrl,
      target: { containers: ["agent"], port: targetPort, protocol: "http" } }] : [] }));
  } else if (request.method === "POST" && request.url === "/api/urls") {
    request.resume();
    request.on("end", () => { created = true; response.end(JSON.stringify({ urls: [{ url: externalUrl }] })); });
  } else response.writeHead(404).end("{}");
}).listen(socket);
https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (request, response) => {
  const upstream = http.request({ hostname: "127.0.0.1", port: targetPort, path: request.url,
    method: request.method, headers: request.headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => response.writeHead(502).end());
  request.pipe(upstream);
}).listen(externalPort, "127.0.0.1");
EOF

node "$work_dir/controller.mjs" "$socket" "$port" "$external_port" \
  "$work_dir/key.pem" "$work_dir/cert.pem" &
controller_pid=$!
for attempt in $(seq 1 100); do
  [[ -S "$socket" ]] && break
  [[ "$attempt" -lt 100 ]] || { echo "real-runtime controller did not become ready" >&2; exit 1; }
  sleep 0.02
done

run_launcher() {
  env -i HOME="$work_dir/home" PATH="$work_dir/tools:/usr/local/bin:/usr/bin:/bin" \
    DIM_WEB_URL_SOCKET="$socket" DIM_WEB_URL_CONTAINERS_JSON='["agent"]' \
    OPENCODE_WEB_PORT="$port" bash "$repo_root/scripts/opencode-web.bash"
}

first_output="$(run_launcher 2>"$work_dir/first.stderr")"
credential_file="$work_dir/home/.local/state/opencode-web/credentials"
password="$(sed -n '2p' "$credential_file")"
server_pid="$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")"
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/global/health")" = 401 ]]
[[ "$(curl --insecure --silent --output /dev/null --write-out '%{http_code}' "https://127.0.0.1:$external_port/global/health")" = 401 ]]
auth_config="$work_dir/curl-auth"
printf 'user = "opencode:%s"\n' "$password" >"$auth_config"
chmod 0600 "$auth_config"
[[ "$(curl --config "$auth_config" --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/global/health")" = 200 ]]
[[ "$(curl --config "$auth_config" --insecure --silent --output /dev/null --write-out '%{http_code}' "https://127.0.0.1:$external_port/global/health")" = 200 ]]
second_output="$(run_launcher 2>"$work_dir/second.stderr")"
[[ "$first_output" = "$second_output" ]]
[[ "$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")" = "$server_pid" ]]
[[ "$first_output" != *"$password"* ]]
! tr '\0' '\n' <"/proc/$server_pid/cmdline" | grep -Fq "$password"
! grep -Fq "$password" "$work_dir/home/.local/state/opencode-web/server.log"
[[ "$(stat -c %a "$work_dir/home/.local/state/opencode-web")" = 700 ]]
[[ "$(stat -c %a "$credential_file")" = 600 ]]

terminated_pid="$server_pid"
kill "$terminated_pid"
wait "$terminated_pid" 2>/dev/null || true
server_pid=""
rm -f "$work_dir/home/.local/state/opencode-web/server.pid"
! kill -0 "$terminated_pid" 2>/dev/null
! curl --silent --max-time 1 "http://127.0.0.1:$port/global/health" >/dev/null
printf '%s\n' opencode-web-real-runtime-smoke-ok
