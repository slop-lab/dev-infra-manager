#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
launcher="$repo_root/scripts/opencode-web.bash"
work_dir="$(mktemp -d /tmp/dim-opencode-web-failures.XXXXXX)"
socket_pid=""
orphan_pid=""

cleanup() {
  for home in "$work_dir"/*-home; do
    if [[ -r "$home/.local/state/opencode-web/server.pid" ]]; then
      kill "$(cut -d ' ' -f 1 "$home/.local/state/opencode-web/server.pid")" 2>/dev/null || true
    fi
  done
  [[ -z "$orphan_pid" ]] || kill "$orphan_pid" 2>/dev/null || true
  [[ -z "$orphan_pid" ]] || wait "$orphan_pid" 2>/dev/null || true
  [[ -z "$socket_pid" ]] || kill "$socket_pid" 2>/dev/null || true
  [[ -z "$socket_pid" ]] || wait "$socket_pid" 2>/dev/null || true
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

mkdir -p "$work_dir/tools"
cat >"$work_dir/tools/opencode" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --version ]]; then
  printf '%s\n' 1.18.31
  exit 0
fi
[[ "${1:-}" == web ]]
shift
hostname=""
port=""
while (($#)); do
  case "$1" in
    --hostname) hostname="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --cors) shift 2 ;;
    *) exit 64 ;;
  esac
done
[[ "${MOCK_OPENCODE_FAIL:-0}" != 1 ]] || exit 73
exec node "$MOCK_OPENCODE_SERVER" "$hostname" "$port"
EOF
cat >"$work_dir/tools/dim-development-service" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ -z "${MOCK_HELPER_PID_FILE:-}" ]] || printf '%s\n' "$$" >"$MOCK_HELPER_PID_FILE"
case "${MOCK_EXPOSE_MODE:-valid}" in
  valid) printf '%s\n' 'https://opencode.example.test' ;;
  stall) sleep 60 ;;
  *) exit 64 ;;
esac
EOF
chmod 0700 "$work_dir/tools/opencode" "$work_dir/tools/dim-development-service"

cat >"$work_dir/opencode-server.mjs" <<'EOF'
import http from "node:http";
const [hostname, portText] = process.argv.slice(2);
const expected = `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
http.createServer((request, response) => {
  if (process.env.MOCK_OPENCODE_STALL === "1") return;
  if (request.headers.authorization !== expected) {
    response.writeHead(401, { "www-authenticate": 'Basic realm="OpenCode"' });
    response.end("Unauthorized");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"healthy":true}');
}).listen(Number.parseInt(portText, 10), hostname);
EOF
cat >"$work_dir/socket.mjs" <<'EOF'
import fs from "node:fs";
import http from "node:http";
const socket = process.argv[2];
try { fs.unlinkSync(socket); } catch (error) { if (error.code !== "ENOENT") throw error; }
http.createServer((_request, response) => response.writeHead(404).end()).listen(socket);
EOF

available_port() {
  node -e 'const server=require("node:net").createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close()})'
}

socket="$work_dir/development.sock"
node "$work_dir/socket.mjs" "$socket" &
socket_pid=$!
for attempt in $(seq 1 100); do
  [[ -S "$socket" ]] && break
  [[ "$attempt" -lt 100 ]] || { printf 'development socket did not become ready\n' >&2; exit 1; }
  sleep 0.02
done

common_env=(
  PATH="$work_dir/tools:$PATH"
  MOCK_OPENCODE_SERVER="$work_dir/opencode-server.mjs"
  MOCK_HELPER_PID_FILE="$work_dir/helper.pid"
  DIM_DEVELOPMENT_URL_SOCKET="$work_dir/generic-development.sock"
  OPENCODE_WEB_URL_SOCKET="$socket"
  OPENCODE_WEB_CORS_ORIGINS='[]'
)

orphan_home="$work_dir/orphan-home"
orphan_port="$(available_port)"
orphan_password=0123456789abcdef0123456789abcdef
mkdir -p "$orphan_home/.local/state/opencode-web"
printf 'opencode\n%s\n' "$orphan_password" >"$orphan_home/.local/state/opencode-web/credentials"
chmod 0600 "$orphan_home/.local/state/opencode-web/credentials"
OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD="$orphan_password" \
  node "$work_dir/opencode-server.mjs" 127.0.0.1 "$orphan_port" &
orphan_pid=$!
for attempt in $(seq 1 100); do
  code="$(printf 'user = "opencode:%s"\n' "$orphan_password" | curl --config - --silent \
    --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$orphan_port/global/health" || true)"
  [[ "$code" = 200 ]] && break
  [[ "$attempt" -lt 100 ]] || { printf 'same-credential orphan did not become ready\n' >&2; exit 1; }
  sleep 0.02
done
if env "${common_env[@]}" HOME="$orphan_home" OPENCODE_WEB_PORT="$orphan_port" \
  MOCK_OPENCODE_FAIL=1 bash "$launcher" >/dev/null 2>"$work_dir/orphan.stderr"; then
  printf 'launcher adopted a same-credential unrecorded listener\n' >&2
  exit 1
fi
grep -Fq 'OpenCode Web exited before becoming ready' "$work_dir/orphan.stderr"
kill -0 "$orphan_pid"
[[ ! -e "$orphan_home/.local/state/opencode-web/server.pid" ]]
kill "$orphan_pid"
wait "$orphan_pid" 2>/dev/null || true
orphan_pid=""

lock_home="$work_dir/lock-home"
mkdir -p "$lock_home/.local/state/opencode-web"
exec {held_lock_fd}>"$lock_home/.local/state/opencode-web/launch.lock"
flock "$held_lock_fd"
lock_started="$(date +%s)"
if timeout 8 env "${common_env[@]}" HOME="$lock_home" OPENCODE_WEB_PORT="$(available_port)" \
  bash "$launcher" >/dev/null 2>"$work_dir/lock.stderr"; then
  printf 'launcher bypassed an active launch lock\n' >&2
  exit 1
fi
[[ "$(( $(date +%s) - lock_started ))" -lt 8 ]]
grep -Fq 'timed out waiting for the launch lock' "$work_dir/lock.stderr"
exec {held_lock_fd}>&-

readiness_home="$work_dir/readiness-home"
mkdir -p "$readiness_home"
readiness_port="$(available_port)"
readiness_started="$(date +%s)"
if timeout 16 env "${common_env[@]}" HOME="$readiness_home" OPENCODE_WEB_PORT="$readiness_port" \
  MOCK_OPENCODE_STALL=1 bash "$launcher" >/dev/null 2>"$work_dir/readiness.stderr"; then
  printf 'launcher accepted a server with stalled health requests\n' >&2
  exit 1
fi
[[ "$(( $(date +%s) - readiness_started ))" -lt 16 ]]
grep -Fq 'before the readiness deadline' "$work_dir/readiness.stderr"
[[ ! -e "$readiness_home/.local/state/opencode-web/server.pid" ]]
! curl --silent --max-time 1 "http://127.0.0.1:$readiness_port/global/health" >/dev/null

helper_home="$work_dir/helper-home"
mkdir -p "$helper_home"
helper_port="$(available_port)"
helper_started="$(date +%s)"
if timeout 35 env "${common_env[@]}" HOME="$helper_home" OPENCODE_WEB_PORT="$helper_port" \
  MOCK_EXPOSE_MODE=stall bash "$launcher" >/dev/null 2>"$work_dir/helper.stderr"; then
  printf 'launcher accepted a stalled development-service helper\n' >&2
  exit 1
fi
[[ "$(( $(date +%s) - helper_started ))" -lt 35 ]]
grep -Fq 'could not expose OpenCode Web' "$work_dir/helper.stderr"
[[ ! -e "$helper_home/.local/state/opencode-web/server.pid" ]]
! curl --silent --max-time 1 "http://127.0.0.1:$helper_port/global/health" >/dev/null
helper_pid="$(cat "$work_dir/helper.pid")"
! kill -0 "$helper_pid" 2>/dev/null

printf '%s\n' opencode-web-launcher-failure-smoke-ok
