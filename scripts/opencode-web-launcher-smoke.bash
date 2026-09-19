#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
launcher="$repo_root/scripts/opencode-web.bash"
work_dir="$(mktemp -d /tmp/dim-opencode-web.XXXXXX)"
controller_pid=""
unrelated_pid=""
unprotected_pid=""
forged_pid=""
orphan_pid=""
stalled_pid=""

cleanup() {
  if [[ -r "$work_dir/home/.local/state/opencode-web/server.pid" ]]; then
    kill "$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")" 2>/dev/null || true
  fi
  [[ -z "$controller_pid" ]] || kill "$controller_pid" 2>/dev/null || true
  [[ -z "$controller_pid" ]] || wait "$controller_pid" 2>/dev/null || true
  [[ -z "$unrelated_pid" ]] || kill "$unrelated_pid" 2>/dev/null || true
  [[ -z "$unrelated_pid" ]] || wait "$unrelated_pid" 2>/dev/null || true
  [[ -z "$unprotected_pid" ]] || kill "$unprotected_pid" 2>/dev/null || true
  [[ -z "$unprotected_pid" ]] || wait "$unprotected_pid" 2>/dev/null || true
  [[ -z "$forged_pid" ]] || kill "$forged_pid" 2>/dev/null || true
  [[ -z "$forged_pid" ]] || wait "$forged_pid" 2>/dev/null || true
  [[ -z "$orphan_pid" ]] || kill "$orphan_pid" 2>/dev/null || true
  [[ -z "$orphan_pid" ]] || wait "$orphan_pid" 2>/dev/null || true
  [[ -z "$stalled_pid" ]] || kill "$stalled_pid" 2>/dev/null || true
  [[ -z "$stalled_pid" ]] || wait "$stalled_pid" 2>/dev/null || true
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

mkdir -p "$work_dir/home" "$work_dir/tools"
cat >"$work_dir/tools/opencode" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --version ]]; then
  printf '%s\n' "${MOCK_OPENCODE_VERSION:-1.18.31}"
  exit 0
fi
[[ "${1:-}" == web ]] || exit 64
shift
port=""
while (($#)); do
  case "$1" in
    --hostname) shift 2 ;;
    --port) port="$2"; shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ -n "$port" ]]
[[ "${MOCK_OPENCODE_FAIL:-0}" != 1 ]] || exit 73
if [[ "${MOCK_OPENCODE_EXIT_DELAY:-0}" == 1 ]]; then
  sleep 1
  exit 73
fi
exec node "$MOCK_OPENCODE_SERVER" "$port"
EOF
chmod 0700 "$work_dir/tools/opencode"

cat >"$work_dir/opencode-server.mjs" <<'EOF'
import http from "node:http";

const port = Number.parseInt(process.argv[2], 10);
const username = process.env.OPENCODE_SERVER_USERNAME;
const password = process.env.OPENCODE_SERVER_PASSWORD;
const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
http.createServer((request, response) => {
  if (process.env.MOCK_OPENCODE_STALL === "1") return;
  if (request.headers.authorization !== expected) {
    response.writeHead(401, { "www-authenticate": 'Basic realm="OpenCode"' });
    response.end("Unauthorized");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(request.url === "/global/health" ? '{"healthy":true}' : "OpenCode Web");
}).listen(port, "0.0.0.0");
EOF

cat >"$work_dir/controller.mjs" <<'EOF'
import fs from "node:fs";
import http from "node:http";

const [socket, countFile, targetPort, modeFile, requestFile] = process.argv.slice(2);
const url = "https://workspace--0.example.test";
let created = false;
try { fs.unlinkSync(socket); } catch (error) { if (error.code !== "ENOENT") throw error; }
http.createServer((request, response) => {
  const mode = fs.readFileSync(modeFile, "utf8").trim();
  if (request.method === "GET" && request.url === "/api") {
    if (mode === "stall-api") return;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ routes: [{ path: "/api/urls", discovery: { ingresses: [
      { name: "https-ts", description: "HTTPS test ingress", scheme: "https" },
      { name: "http-ts", description: "HTTP test ingress", scheme: "http" }
    ] } }] }));
    return;
  }
  if (request.method === "GET" && request.url === "/api/urls") {
    if (mode === "stall-list") return;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ urls: created ? [{
      id: "url-1", ingress: "https-ts", url,
      target: { containers: ["agent-dind", "dim-agent"], port: Number.parseInt(targetPort, 10), protocol: "http" }
    }] : [] }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/urls") {
    if (mode === "stall-post") return;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      fs.writeFileSync(requestFile, body);
      fs.appendFileSync(countFile, "request\n");
      response.setHeader("content-type", "application/json");
      if (mode === "invalid") {
        response.end("{}");
        return;
      }
      created = true;
      response.end(JSON.stringify({ urls: [{ id: "url-1", url }] }));
    });
    return;
  }
  response.writeHead(404).end();
}).listen(socket);
EOF

available_port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
port="$(available_port)"
socket="$work_dir/controller.sock"
count_file="$work_dir/controller-count"
mode_file="$work_dir/controller-mode"
request_file="$work_dir/controller-request"
printf '%s\n' valid >"$mode_file"
node "$work_dir/controller.mjs" "$socket" "$count_file" "$port" "$mode_file" "$request_file" &
controller_pid=$!
for attempt in $(seq 1 100); do
  [[ -S "$socket" ]] && break
  [[ "$attempt" -lt 100 ]] || { echo "controller socket did not become ready" >&2; exit 1; }
  sleep 0.02
done
base_env=(
  HOME="$work_dir/home"
  PATH="$work_dir/tools:$PATH"
  MOCK_OPENCODE_SERVER="$work_dir/opencode-server.mjs"
  DIM_WEB_URL_SOCKET="$socket"
  'DIM_WEB_URL_CONTAINERS_JSON=["agent-dind","dim-agent"]'
  OPENCODE_WEB_PORT="$port"
)

mkdir -p "$work_dir/missing-tools"
for prerequisite in curl flock jq node nohup; do
  ln -s "$(command -v "$prerequisite")" "$work_dir/missing-tools/$prerequisite"
done
if env HOME="$work_dir/home" PATH="$work_dir/missing-tools" /usr/bin/bash "$launcher" \
  >/dev/null 2>"$work_dir/missing-opencode"; then
  echo "launcher accepted a missing OpenCode prerequisite" >&2
  exit 1
fi
grep -Fq 'required command not found on PATH: opencode' "$work_dir/missing-opencode"

if env "${base_env[@]}" MOCK_OPENCODE_VERSION=1.18.30 bash "$launcher" \
  >/dev/null 2>"$work_dir/version-mismatch"; then
  echo "launcher accepted an unexpected OpenCode version" >&2
  exit 1
fi
grep -Fq 'expected opencode 1.18.31' "$work_dir/version-mismatch"

if env "${base_env[@]}" OPENCODE_WEB_PORT=invalid bash "$launcher" >/dev/null 2>"$work_dir/invalid-port"; then
  echo "launcher accepted an invalid port" >&2
  exit 1
fi
grep -Fq 'port must be an integer from 1 through 65535' "$work_dir/invalid-port"

if env "${base_env[@]}" OPENCODE_WEB_PORT=18446744073709551617 bash "$launcher" \
  >/dev/null 2>"$work_dir/overflow-port"; then
  echo "launcher accepted an overflowing port" >&2
  exit 1
fi
grep -Fq 'port must be an integer from 1 through 65535' "$work_dir/overflow-port"

if env "${base_env[@]}" DIM_WEB_URL_INGRESS=http-ts bash "$launcher" \
  >/dev/null 2>"$work_dir/http-ingress"; then
  echo "launcher accepted a cleartext external ingress" >&2
  exit 1
fi
grep -Fq 'external URL ingress must use HTTPS' "$work_dir/http-ingress"
[[ ! -e "$work_dir/home/.local/state/opencode-web/server.pid" ]]

if env "${base_env[@]}" DIM_WEB_URL_CONTAINERS_JSON=object bash "$launcher" >/dev/null 2>"$work_dir/invalid-target"; then
  echo "launcher accepted invalid container JSON" >&2
  exit 1
fi
grep -Fq 'DIM_WEB_URL_CONTAINERS_JSON must be a non-empty JSON array of non-empty strings' "$work_dir/invalid-target"

if env "${base_env[@]}" DIM_WEB_URL_SOCKET="$work_dir/missing.sock" bash "$launcher" >/dev/null 2>"$work_dir/missing-socket"; then
  echo "launcher accepted a missing controller socket" >&2
  exit 1
fi
grep -Fq 'external URL controller socket not found' "$work_dir/missing-socket"

if env HOME="$work_dir/home" PATH="$work_dir/tools:$PATH" \
  DIM_EXTERNAL_URL_SOCKET="$socket" \
  'DIM_EXTERNAL_URL_CONTAINERS_JSON=["agent-dind","dim-agent"]' \
  OPENCODE_WEB_PORT="$port" bash "$launcher" >/dev/null 2>"$work_dir/generic-only"; then
  echo "launcher accepted the generic external URL capability" >&2
  exit 1
fi
grep -Fq 'DIM_WEB_URL_SOCKET is required' "$work_dir/generic-only"

printf '%s\n' stall-api >"$mode_file"
stall_started="$(date +%s)"
if timeout 8 env "${base_env[@]}" bash "$launcher" >/dev/null 2>"$work_dir/stalled-proxy"; then
  echo "launcher accepted a stalled Web URL proxy" >&2
  exit 1
fi
stall_elapsed="$(( $(date +%s) - stall_started ))"
[[ "$stall_elapsed" -lt 8 ]]
grep -Fq 'could not discover external URL ingresses' "$work_dir/stalled-proxy"
printf '%s\n' valid >"$mode_file"

locked_home="$work_dir/locked-home"
mkdir -p "$locked_home/.local/state/opencode-web"
exec {held_lock_fd}>"$locked_home/.local/state/opencode-web/launch.lock"
flock "$held_lock_fd"
lock_started="$(date +%s)"
if timeout 8 env "${base_env[@]}" HOME="$locked_home" bash "$launcher" \
  >/dev/null 2>"$work_dir/lock-timeout"; then
  echo "launcher bypassed an active launch lock" >&2
  exit 1
fi
lock_elapsed="$(( $(date +%s) - lock_started ))"
[[ "$lock_elapsed" -lt 8 ]]
grep -Fq 'timed out waiting for the launch lock' "$work_dir/lock-timeout"
exec {held_lock_fd}>&-

unsafe_home="$work_dir/unsafe-home"
mkdir -p "$unsafe_home/.local/state/opencode-web"
printf '%s\n' sentinel >"$work_dir/outside-lock"
ln -s "$work_dir/outside-lock" "$unsafe_home/.local/state/opencode-web/launch.lock"
if env "${base_env[@]}" HOME="$unsafe_home" MOCK_OPENCODE_FAIL=1 bash "$launcher" \
  >/dev/null 2>"$work_dir/unsafe-lock"; then
  echo "launcher accepted a symbolic-link lock file" >&2
  exit 1
fi
grep -Fq 'unsafe state file' "$work_dir/unsafe-lock"
grep -Fqx sentinel "$work_dir/outside-lock"

credential_home="$work_dir/credential-home"
mkdir -p "$credential_home/.local/state/opencode-web"
printf '%s\n' opencode 0123456789abcdef0123456789abcdef \
  >"$credential_home/.local/state/opencode-web/credentials"
chmod 0644 "$credential_home/.local/state/opencode-web/credentials"
if env "${base_env[@]}" HOME="$credential_home" MOCK_OPENCODE_FAIL=1 bash "$launcher" \
  >/dev/null 2>"$work_dir/unsafe-credentials"; then
  echo "launcher accepted broadly readable credentials" >&2
  exit 1
fi
grep -Fq 'credential file must have mode 0600' "$work_dir/unsafe-credentials"

forged_home="$work_dir/forged-home"
mkdir -p "$forged_home/.local/state/opencode-web"
printf '%s\n' opencode 0123456789abcdef0123456789abcdef \
  >"$forged_home/.local/state/opencode-web/credentials"
chmod 0600 "$forged_home/.local/state/opencode-web/credentials"
bash -c 'while :; do sleep 1; done' &
forged_pid=$!
forged_start="$(node - "$forged_pid" <<'NODE'
import fs from "node:fs";
const source = fs.readFileSync(`/proc/${process.argv[2]}/stat`, "utf8");
process.stdout.write(source.slice(source.lastIndexOf(")") + 2).trim().split(/\s+/)[19]);
NODE
)"
printf '%s %s %s\n' "$forged_pid" "$forged_start" "$port" \
  >"$forged_home/.local/state/opencode-web/server.pid"
chmod 0600 "$forged_home/.local/state/opencode-web/server.pid"
if env "${base_env[@]}" HOME="$forged_home" MOCK_OPENCODE_FAIL=1 bash "$launcher" \
  >/dev/null 2>"$work_dir/forged-pid"; then
  echo "launcher unexpectedly succeeded with the failing OpenCode fixture" >&2
  exit 1
fi
kill -0 "$forged_pid"
kill "$forged_pid"
wait "$forged_pid" 2>/dev/null || true
forged_pid=""

orphan_home="$work_dir/orphan-home"
mkdir -p "$orphan_home/.local/state/opencode-web"
orphan_password=0123456789abcdef0123456789abcdef
printf 'opencode\n%s\n' "$orphan_password" >"$orphan_home/.local/state/opencode-web/credentials"
chmod 0600 "$orphan_home/.local/state/opencode-web/credentials"
OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD="$orphan_password" \
  node "$work_dir/opencode-server.mjs" "$port" &
orphan_pid=$!
for attempt in $(seq 1 100); do
  orphan_code="$(printf 'user = "opencode:%s"\n' "$orphan_password" | curl --config - --silent \
    --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/global/health" || true)"
  [[ "$orphan_code" = 200 ]] && break
  [[ "$attempt" -lt 100 ]] || { echo "authenticated orphan fixture did not become ready" >&2; exit 1; }
  sleep 0.02
done
if env "${base_env[@]}" HOME="$orphan_home" MOCK_OPENCODE_EXIT_DELAY=1 bash "$launcher" \
  >/dev/null 2>"$work_dir/authenticated-orphan"; then
  echo "launcher adopted an unrecorded authenticated listener" >&2
  exit 1
fi
grep -Fq 'OpenCode Web exited before becoming ready' "$work_dir/authenticated-orphan"
kill -0 "$orphan_pid"
[[ ! -e "$orphan_home/.local/state/opencode-web/server.pid" ]]
kill "$orphan_pid"
wait "$orphan_pid" 2>/dev/null || true
orphan_pid=""

stalled_port="$(available_port)"
stalled_started="$(date +%s)"
if timeout 16 env "${base_env[@]}" OPENCODE_WEB_PORT="$stalled_port" MOCK_OPENCODE_STALL=1 \
  bash "$launcher" >/dev/null 2>"$work_dir/stalled-readiness"; then
  echo "launcher accepted a server that never completed health requests" >&2
  exit 1
fi
stalled_elapsed="$(( $(date +%s) - stalled_started ))"
[[ "$stalled_elapsed" -lt 16 ]]
grep -Fq 'before the readiness deadline' "$work_dir/stalled-readiness"
if curl --silent --max-time 1 "http://127.0.0.1:$stalled_port/global/health" >/dev/null; then
  echo "launcher left the stalled server running" >&2
  exit 1
fi

unprotected_port="$(available_port)"
node -e 'require("node:http").createServer((request, response) => { response.setHeader("content-type", "application/json"); response.end("{\"healthy\":true}") }).listen(Number.parseInt(process.argv[1], 10), "127.0.0.1")' \
  "$unprotected_port" &
unprotected_pid=$!
for attempt in $(seq 1 100); do
  [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$unprotected_port/global/health" || true)" = 200 ]] && break
  [[ "$attempt" -lt 100 ]] || { echo "unprotected fixture did not become ready" >&2; exit 1; }
  sleep 0.02
done
if env "${base_env[@]}" OPENCODE_WEB_PORT="$unprotected_port" MOCK_OPENCODE_FAIL=1 bash "$launcher" \
  >/dev/null 2>"$work_dir/unprotected-port"; then
  echo "launcher adopted an unauthenticated listener" >&2
  exit 1
fi
grep -Fq 'OpenCode Web exited before becoming ready' "$work_dir/unprotected-port"
kill -0 "$unprotected_pid"
kill "$unprotected_pid"
wait "$unprotected_pid" 2>/dev/null || true
unprotected_pid=""

unrelated_marker="$work_dir/unrelated-alive"
bash -c 'trap "touch \"$1\"; exit" TERM; while :; do sleep 1; done' bash "$unrelated_marker" &
unrelated_pid=$!

first_output="$(env "${base_env[@]}" bash "$launcher")"
grep -Fqx 'url: https://workspace--0.example.test' <<<"$first_output"
grep -Fqx 'username: opencode' <<<"$first_output"
credential_file="$work_dir/home/.local/state/opencode-web/credentials"
grep -Fqx "credentials: $credential_file" <<<"$first_output"
[[ "$first_output" != *password:* ]]
password="$(sed -n '2p' "$credential_file")"
[[ "$password" =~ ^[A-Za-z0-9_-]{32}$ ]]
[[ "$(stat -c %a "$credential_file")" == 600 ]]
[[ "$(stat -c %a "$work_dir/home/.local/state/opencode-web")" == 700 ]]
server_pid="$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")"
[[ "$(stat -c %a "$work_dir/home/.local/state/opencode-web/server.pid")" == 600 ]]
[[ "$(stat -c %a "$work_dir/home/.local/state/opencode-web/server.log")" == 600 ]]
kill -0 "$server_pid"
lock_file="$work_dir/home/.local/state/opencode-web/launch.lock"
for descriptor in "/proc/$server_pid/fd"/*; do
  [[ "$(readlink "$descriptor" 2>/dev/null || true)" != "$lock_file" ]]
done
if tr '\0' '\n' <"/proc/$server_pid/cmdline" | grep -Fq "$password"; then
  echo "launcher exposed its credential in the server command line" >&2
  exit 1
fi
if grep -Fq "$password" "$work_dir/home/.local/state/opencode-web/server.log"; then
  echo "launcher exposed its credential in the server log" >&2
  exit 1
fi
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/global/health")" == 401 ]]
auth_code="$(printf 'user = "opencode:%s"\n' "$password" | curl --config - --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/global/health")"
[[ "$auth_code" == 200 ]]
node - "$request_file" "$port" <<'NODE'
import fs from "node:fs";

const [requestFile, port] = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
if (request.ingress !== "https-ts") throw new Error("launcher requested the wrong ingress");
if (request.target.protocol !== "http") throw new Error("launcher requested the wrong protocol");
if (request.target.port !== Number.parseInt(port, 10)) throw new Error("launcher requested the wrong port");
if (JSON.stringify(request.target.containers) !== JSON.stringify(["agent-dind", "dim-agent"])) {
  throw new Error("launcher requested the wrong container path");
}
NODE

second_output="$(env "${base_env[@]}" bash "$launcher")"
[[ "$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")" == "$server_pid" ]]
[[ "$second_output" == "$first_output" ]]
[[ "$(wc -l <"$count_file")" == 1 ]]
kill -0 "$unrelated_pid"
kill "$unrelated_pid"
wait "$unrelated_pid" 2>/dev/null || true
unrelated_pid=""
[[ -e "$unrelated_marker" ]]

kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
rm -f "$work_dir/home/.local/state/opencode-web/server.pid"
failure_port="$(available_port)"
if env "${base_env[@]}" OPENCODE_WEB_PORT="$failure_port" MOCK_OPENCODE_FAIL=1 bash "$launcher" \
  >"$work_dir/start-failure.stdout" 2>"$work_dir/start-failure.stderr"; then
  echo "launcher accepted a failed OpenCode process" >&2
  exit 1
fi
grep -Fq 'OpenCode Web exited before becoming ready' "$work_dir/start-failure.stderr"
[[ ! -e "$work_dir/home/.local/state/opencode-web/server.pid" ]]

invalid_response_port="$(available_port)"
printf '%s\n' invalid >"$mode_file"
if env "${base_env[@]}" OPENCODE_WEB_PORT="$invalid_response_port" bash "$launcher" \
  >"$work_dir/invalid-response.stdout" 2>"$work_dir/invalid-response.stderr"; then
  echo "launcher accepted an external URL response without a URL" >&2
  exit 1
fi
grep -Fq 'external URL response did not contain a URL' "$work_dir/invalid-response.stderr"
[[ ! -e "$work_dir/home/.local/state/opencode-web/server.pid" ]]
if curl --silent --max-time 1 "http://127.0.0.1:$invalid_response_port/global/health" >/dev/null; then
  echo "launcher left its server running after external URL setup failed" >&2
  exit 1
fi

printf '%s\n' opencode-web-launcher-smoke-ok
