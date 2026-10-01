#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
launcher="$repo_root/scripts/opencode-web.bash"
work_dir="$(mktemp -d /tmp/dim-opencode-web.XXXXXX)"
socket_pid=""
unrelated_pid=""
unowned_pid=""

cleanup() {
  if [[ -r "$work_dir/home/.local/state/opencode-web/server.pid" ]]; then
    kill "$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")" 2>/dev/null || true
  fi
  for process_id in "$socket_pid" "$unrelated_pid" "$unowned_pid"; do
    [[ -z "$process_id" ]] || kill "$process_id" 2>/dev/null || true
    [[ -z "$process_id" ]] || wait "$process_id" 2>/dev/null || true
  done
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

mkdir -p "$work_dir/home" "$work_dir/tools"
cat >"$work_dir/tools/opencode" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --version ]]; then
  [[ -z "${MOCK_OPENCODE_VERSION_PROBE:-}" ]] || printf '%s\n' probed >>"$MOCK_OPENCODE_VERSION_PROBE"
  printf '%s\n' "${MOCK_OPENCODE_VERSION:-1.18.31}"
  exit 0
fi
[[ "${1:-}" == web ]]
shift
hostname=""
port=""
cors=()
while (($#)); do
  case "$1" in
    --hostname) hostname="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --cors) cors+=("$2"); shift 2 ;;
    *) exit 64 ;;
  esac
done
printf '%s %s' "$hostname" "$port" >"$MOCK_OPENCODE_ARGUMENTS"
printf ' --cors=%s' "${cors[@]}" >>"$MOCK_OPENCODE_ARGUMENTS"
printf '\n' >>"$MOCK_OPENCODE_ARGUMENTS"
[[ "${MOCK_OPENCODE_FAIL:-0}" != 1 ]] || exit 73
[[ "${MOCK_OPENCODE_HOLD:-0}" != 1 ]] || exec sleep 120
exec node "$MOCK_OPENCODE_SERVER" "$hostname" "$port"
EOF
chmod 0700 "$work_dir/tools/opencode"

cat >"$work_dir/tools/dim-development-service" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${DIM_DEVELOPMENT_URL_SOCKET:-}" == "$MOCK_DEVELOPMENT_SOCKET" ]]
printf '%s\n' "$*" >>"$MOCK_EXPOSE_ARGUMENTS"
env | grep '^DIM_' | sort >"$MOCK_EXPOSE_ENVIRONMENT"
case "$(cat "$MOCK_EXPOSE_MODE")" in
  valid) printf '%s\n' 'https://opencode.example.test' ;;
  fail) exit 70 ;;
  invalid) printf '%s\n' 'http://opencode.example.test' ;;
  stall) sleep 120 ;;
  *) exit 64 ;;
esac
EOF
chmod 0700 "$work_dir/tools/dim-development-service"

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
  response.end(request.url === "/global/health" ? '{"healthy":true}' : "OpenCode Web");
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
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

socket="$work_dir/development.sock"
node "$work_dir/socket.mjs" "$socket" &
socket_pid=$!
for attempt in $(seq 1 100); do
  [[ -S "$socket" ]] && break
  [[ "$attempt" -lt 100 ]] || { printf 'development socket did not become ready\n' >&2; exit 1; }
  sleep 0.02
done

port="$(available_port)"
mode_file="$work_dir/expose-mode"
arguments_file="$work_dir/expose-arguments"
environment_file="$work_dir/expose-environment"
opencode_arguments="$work_dir/opencode-arguments"
printf '%s\n' valid >"$mode_file"
base_env=(
  HOME="$work_dir/home"
  PATH="$work_dir/tools:$PATH"
  MOCK_OPENCODE_SERVER="$work_dir/opencode-server.mjs"
  MOCK_OPENCODE_ARGUMENTS="$opencode_arguments"
  MOCK_OPENCODE_VERSION_PROBE="$work_dir/version-probes"
  MOCK_DEVELOPMENT_SOCKET="$socket"
  MOCK_EXPOSE_ARGUMENTS="$arguments_file"
  MOCK_EXPOSE_ENVIRONMENT="$environment_file"
  MOCK_EXPOSE_MODE="$mode_file"
  DIM_DEVELOPMENT_URL_SOCKET="$socket"
  OPENCODE_WEB_PORT="$port"
)

for invalid_cors in 'not-json' 'null' '["*"]' '["https://*.example"]' '["https://%2a.example.com"]' '["ftp://remote-web.example"]' \
  '["https://user@remote-web.example"]' '["https://remote-web.example/path"]' \
  '["https://remote-web.example/%2e%2e"]' \
  '["https://remote-web.example?query=yes"]' '["https://remote-web.example#fragment"]'; do
  rm -f "$work_dir/version-probes"
  if env "${base_env[@]}" OPENCODE_WEB_CORS_ORIGINS="$invalid_cors" bash "$launcher" \
    >/dev/null 2>"$work_dir/invalid-cors"; then
    printf 'launcher accepted invalid CORS origins: %s\n' "$invalid_cors" >&2
    exit 1
  fi
  grep -Fq 'OPENCODE_WEB_CORS_ORIGINS' "$work_dir/invalid-cors"
  [[ ! -e "$work_dir/version-probes" ]]
  [[ ! -e "$work_dir/home/.local/state/opencode-web" ]]
done

mkdir -p "$work_dir/missing-tools"
for prerequisite in curl flock jq node nohup; do
  ln -s "$(command -v "$prerequisite")" "$work_dir/missing-tools/$prerequisite"
done
ln -s "$work_dir/tools/opencode" "$work_dir/missing-tools/opencode"
if env HOME="$work_dir/home" PATH="$work_dir/missing-tools" /usr/bin/bash "$launcher" \
  >/dev/null 2>"$work_dir/missing-helper"; then
  printf 'launcher accepted a missing development-service helper\n' >&2
  exit 1
fi
grep -Fq 'required command not found on PATH: dim-development-service' "$work_dir/missing-helper"

if env "${base_env[@]}" MOCK_OPENCODE_VERSION=1.18.30 bash "$launcher" \
  >/dev/null 2>"$work_dir/version-mismatch"; then
  printf 'launcher accepted an unexpected OpenCode version\n' >&2
  exit 1
fi
grep -Fq 'expected opencode 1.18.31' "$work_dir/version-mismatch"

for invalid_port in invalid 0 65536 18446744073709551617; do
  if env "${base_env[@]}" OPENCODE_WEB_PORT="$invalid_port" bash "$launcher" \
    >/dev/null 2>"$work_dir/invalid-port"; then
    printf 'launcher accepted invalid port %s\n' "$invalid_port" >&2
    exit 1
  fi
  grep -Fq 'port must be an integer from 1 through 65535' "$work_dir/invalid-port"
done

if env "${base_env[@]}" DIM_DEVELOPMENT_URL_SOCKET="$work_dir/missing.sock" bash "$launcher" \
  >/dev/null 2>"$work_dir/missing-socket"; then
  printf 'launcher accepted a missing development URL socket\n' >&2
  exit 1
fi
grep -Fq 'development URL socket not found' "$work_dir/missing-socket"

if env -u DIM_DEVELOPMENT_URL_SOCKET -u DIM_EXTERNAL_URL_SOCKET \
  -u DIM_EXTERNAL_URL_CONTAINERS_JSON HOME="$work_dir/home" PATH="$work_dir/tools:$PATH" \
  DIM_WEB_URL_SOCKET="$socket" DIM_WEB_URL_CONTAINERS_JSON='["agent"]' \
  OPENCODE_WEB_PORT="$port" bash "$launcher" >/dev/null 2>"$work_dir/obsolete-only"; then
  printf 'launcher accepted obsolete Web URL capabilities\n' >&2
  exit 1
fi
grep -Fq 'DIM_DEVELOPMENT_URL_SOCKET is required' "$work_dir/obsolete-only"

unowned_password=0123456789abcdef0123456789abcdef
state_dir="$work_dir/home/.local/state/opencode-web"
mkdir -p "$state_dir"
chmod 0700 "$state_dir"
printf '%s\n' opencode "$unowned_password" >"$state_dir/credentials"
chmod 0600 "$state_dir/credentials"
OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD="$unowned_password" \
  node "$work_dir/opencode-server.mjs" 127.0.0.1 "$port" &
unowned_pid=$!
for attempt in $(seq 1 100); do
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/global/health" || true)"
  [[ "$status" = 401 ]] && break
  [[ "$attempt" -lt 100 ]] || { printf 'unowned listener did not become ready\n' >&2; exit 1; }
  sleep 0.02
done
unowned_status=0
timeout --kill-after=2s 20s env "${base_env[@]}" MOCK_OPENCODE_HOLD=1 \
  bash "$launcher" >/dev/null 2>"$work_dir/unowned" || unowned_status=$?
if [[ "$unowned_status" != 1 ]]; then
  printf 'launcher adopted an unrecorded listener\n' >&2
  exit 1
fi
grep -Fq 'did not own its listening socket before the readiness deadline' "$work_dir/unowned"
[[ ! -e "$state_dir/server.pid" ]]
kill -0 "$unowned_pid"
kill "$unowned_pid"
wait "$unowned_pid" 2>/dev/null || true
unowned_pid=""
rm "$state_dir/credentials"

# shellcheck source=lib/opencode-web-failure-checks.bash
source "$script_dir/lib/opencode-web-failure-checks.bash"

unrelated_marker="$work_dir/unrelated-stopped"
bash -c 'trap "touch \"$1\"; exit" TERM; while :; do sleep 1; done' bash "$unrelated_marker" &
unrelated_pid=$!

first_output="$(env "${base_env[@]}" bash "$launcher")"
grep -Fqx 'url: https://opencode.example.test' <<<"$first_output"
grep -Fqx 'username: opencode' <<<"$first_output"
credential_file="$work_dir/home/.local/state/opencode-web/credentials"
grep -Fqx "credentials: $credential_file" <<<"$first_output"
[[ "$first_output" != *password:* ]]
password="$(sed -n '2p' "$credential_file")"
[[ "$password" =~ ^[A-Za-z0-9_-]{32}$ ]]
[[ "$(stat -c %a "$credential_file")" = 600 ]]
[[ "$(stat -c %a "$state_dir")" = 700 ]]
[[ "$(stat -c %a "$state_dir/server.pid")" = 600 ]]
[[ "$(stat -c %a "$state_dir/server.log")" = 600 ]]
! grep -Fq "$password" "$state_dir/server.log"
grep -Fqx "127.0.0.1 $port --cors=https://localhost:4096" "$opencode_arguments"
grep -Fqx "expose --name opencode-web --port $port --ingress https-ts --require-scheme https" "$arguments_file"
grep -Fqx "DIM_DEVELOPMENT_URL_SOCKET=$socket" "$environment_file"
! grep -Eq 'DIM_(WEB_URL|EXTERNAL_URL)|CONTAINERS_JSON|TARGET' "$environment_file"

server_pid="$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")"
kill -0 "$server_pid"
! tr '\0' '\n' <"/proc/$server_pid/cmdline" | grep -Fq "$password"
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/global/health")" = 401 ]]
auth_code="$(printf 'user = "opencode:%s"\n' "$password" | curl --config - --silent --output /dev/null \
  --write-out '%{http_code}' "http://127.0.0.1:$port/global/health")"
[[ "$auth_code" = 200 ]]

second_output="$(env "${base_env[@]}" bash "$launcher")"
[[ "$second_output" = "$first_output" ]]
[[ "$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")" = "$server_pid" ]]
[[ "$(wc -l <"$arguments_file")" = 2 ]]
kill -0 "$unrelated_pid"

for invalid_cors in 'not-json' '["*"]' '["https://%2a.example.com"]'; do
  if env "${base_env[@]}" OPENCODE_WEB_CORS_ORIGINS="$invalid_cors" bash "$launcher" \
    >/dev/null 2>"$work_dir/invalid-cors-running"; then
    printf 'launcher accepted invalid CORS origins while an owned process was running: %s\n' "$invalid_cors" >&2
    exit 1
  fi
  grep -Fq 'OPENCODE_WEB_CORS_ORIGINS' "$work_dir/invalid-cors-running"
  [[ "$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")" = "$server_pid" ]]
  kill -0 "$server_pid"
done

credential_before_change="$(cat "$credential_file")"
additional_cors='["https://remote-web.example/","https://localhost:4096","https://remote-web.example"]'
changed_output="$(env "${base_env[@]}" OPENCODE_WEB_CORS_ORIGINS="$additional_cors" bash "$launcher")"
changed_pid="$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")"
[[ "$changed_output" = "$first_output" ]]
[[ "$changed_pid" != "$server_pid" ]]
! kill -0 "$server_pid" 2>/dev/null
server_pid="$changed_pid"
[[ "$(cat "$credential_file")" = "$credential_before_change" ]]
grep -Fqx "127.0.0.1 $port --cors=https://localhost:4096 --cors=https://remote-web.example" "$opencode_arguments"

equivalent_cors='["https://remote-web.example","https://remote-web.example/"]'
env "${base_env[@]}" OPENCODE_WEB_CORS_ORIGINS="$equivalent_cors" bash "$launcher" >/dev/null
[[ "$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")" = "$server_pid" ]]

default_again_output="$(env "${base_env[@]}" bash "$launcher")"
default_again_pid="$(cut -d ' ' -f 1 "$work_dir/home/.local/state/opencode-web/server.pid")"
[[ "$default_again_output" = "$first_output" ]]
[[ "$default_again_pid" != "$server_pid" ]]
! kill -0 "$server_pid" 2>/dev/null
server_pid="$default_again_pid"
[[ "$(cat "$credential_file")" = "$credential_before_change" ]]
grep -Fqx "127.0.0.1 $port --cors=https://localhost:4096" "$opencode_arguments"
kill -0 "$unrelated_pid"

printf '%s\n' fail >"$mode_file"
if env "${base_env[@]}" bash "$launcher" >/dev/null 2>"$work_dir/expose-failure"; then
  printf 'launcher accepted development-service exposure failure\n' >&2
  exit 1
fi
grep -Fq 'could not expose OpenCode Web' "$work_dir/expose-failure"
kill -0 "$server_pid"
kill -0 "$unrelated_pid"

kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
rm -f "$work_dir/home/.local/state/opencode-web/server.pid"
failure_port="$(available_port)"
if env "${base_env[@]}" OPENCODE_WEB_PORT="$failure_port" MOCK_OPENCODE_FAIL=1 bash "$launcher" \
  >/dev/null 2>"$work_dir/start-failure"; then
  printf 'launcher accepted a failed OpenCode process\n' >&2
  exit 1
fi
grep -Fq 'OpenCode Web exited before becoming ready' "$work_dir/start-failure"
[[ ! -e "$work_dir/home/.local/state/opencode-web/server.pid" ]]

printf '%s\n' invalid >"$mode_file"
invalid_response_port="$(available_port)"
if env "${base_env[@]}" OPENCODE_WEB_PORT="$invalid_response_port" bash "$launcher" \
  >/dev/null 2>"$work_dir/invalid-response"; then
  printf 'launcher accepted a non-HTTPS helper response\n' >&2
  exit 1
fi
grep -Fq 'external URL response did not contain a valid HTTPS URL' "$work_dir/invalid-response"
[[ ! -e "$work_dir/home/.local/state/opencode-web/server.pid" ]]
! curl --silent --max-time 1 "http://127.0.0.1:$invalid_response_port/global/health" >/dev/null
kill -0 "$unrelated_pid"

kill "$unrelated_pid"
wait "$unrelated_pid" 2>/dev/null || true
unrelated_pid=""
[[ -e "$unrelated_marker" ]]
printf '%s\n' opencode-web-launcher-smoke-ok
