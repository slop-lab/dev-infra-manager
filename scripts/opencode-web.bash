#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_OPENCODE_VERSION="1.18.31"
readonly DEFAULT_PORT="4096"
readonly DEFAULT_INGRESS="https-ts"
readonly SERVER_USERNAME="opencode"

fail() {
  printf 'opencode-web: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found on PATH: $1"
}

for command_name in curl flock jq node nohup opencode; do
  require_command "$command_name"
done

[[ -n "${HOME:-}" && "$HOME" = /* && -d "$HOME" && -w "$HOME" ]] || \
  fail 'HOME must be an absolute, writable directory'

port="${OPENCODE_WEB_PORT:-$DEFAULT_PORT}"
port="$(node - "$port" <<'NODE' 2>/dev/null
const input = process.argv[2]
if (!/^\d+$/.test(input)) process.exit(1)
const value = BigInt(input)
if (value < 1n || value > 65535n) process.exit(1)
process.stdout.write(value.toString())
NODE
)" || fail 'port must be an integer from 1 through 65535'
ingress="${DIM_WEB_URL_INGRESS:-$DEFAULT_INGRESS}"
[[ -n "$ingress" && "$ingress" != *$'\n'* && "$ingress" != *$'\r'* ]] || \
  fail 'DIM_WEB_URL_INGRESS must be non-empty and single-line'
controller_socket="${DIM_WEB_URL_SOCKET:-}"
[[ -n "$controller_socket" ]] || fail 'DIM_WEB_URL_SOCKET is required'
[[ -S "$controller_socket" ]] || fail "external URL controller socket not found: $controller_socket"

containers_json="${DIM_WEB_URL_CONTAINERS_JSON:-}"
containers_json="$(jq -ce '
  if type == "array" and length > 0 and all(.[]; type == "string" and length > 0)
  then . else error("invalid") end
' <<<"$containers_json" 2>/dev/null)" || \
  fail 'DIM_WEB_URL_CONTAINERS_JSON must be a non-empty JSON array of non-empty strings'

installed_version="$(opencode --version)"
[[ "$installed_version" = "$EXPECTED_OPENCODE_VERSION" ]] || \
  fail "expected opencode $EXPECTED_OPENCODE_VERSION; run workspace-user-setup.bash first (found $installed_version)"

discovery="$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 --unix-socket "$controller_socket" \
  http://dim-controller/api)" || fail 'could not discover external URL ingresses'
ingress_scheme="$(jq -er --arg ingress "$ingress" '
  first(.routes[]?.discovery.ingresses[]? | select(.name == $ingress) | .scheme)
' <<<"$discovery" 2>/dev/null)" || fail "external URL ingress is unavailable: $ingress"
[[ "$ingress_scheme" = https ]] || fail "external URL ingress must use HTTPS: $ingress"

state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
state_dir="$(node - "$HOME" "$state_home" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const home = fs.realpathSync(process.argv[2])
const requestedStateHome = process.argv[3]
if (!path.isAbsolute(requestedStateHome) || /[\r\n]/.test(requestedStateHome)) {
  throw new Error("XDG_STATE_HOME must be absolute and single-line")
}
const requestedHome = path.resolve(process.argv[2])
const requestedAbsolute = path.resolve(requestedStateHome)
const requestedRelative = path.relative(requestedHome, requestedAbsolute)
const rebased = requestedRelative === "" || (!path.isAbsolute(requestedRelative) && requestedRelative !== ".." && !requestedRelative.startsWith(`..${path.sep}`))
  ? path.join(home, requestedRelative)
  : requestedAbsolute
const relative = path.relative(home, rebased)
if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error("XDG_STATE_HOME must remain below HOME")
}
let current = home
for (const segment of path.join(relative, "opencode-web").split(path.sep).filter(Boolean)) {
  current = path.join(current, segment)
  try {
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe state directory: ${current}`)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    fs.mkdirSync(current, { mode: 0o700 })
  }
  const canonical = fs.realpathSync(current)
  const canonicalRelative = path.relative(home, canonical)
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new Error(`state directory escapes HOME: ${current}`)
  }
  current = canonical
}
process.stdout.write(current)
NODE
)" || fail 'could not create a safe OpenCode Web state directory below HOME'

umask 077
chmod 0700 "$state_dir"
lock_file="$state_dir/launch.lock"
credentials_file="$state_dir/credentials"
pid_file="$state_dir/server.pid"
log_file="$state_dir/server.log"

for state_file in "$lock_file" "$credentials_file" "$pid_file" "$log_file"; do
  [[ ! -L "$state_file" && (! -e "$state_file" || -f "$state_file") ]] || \
    fail "unsafe state file: $state_file"
done

exec {lock_fd}>"$lock_file"
flock --wait 5 "$lock_fd" || fail 'timed out waiting for the launch lock'

if [[ ! -e "$credentials_file" ]]; then
  temporary_credentials="$(mktemp "$state_dir/.credentials.XXXXXX")"
  if ! node -e 'process.stdout.write(`opencode\n${require("node:crypto").randomBytes(24).toString("base64url")}\n`)' \
    >"$temporary_credentials"; then
    rm -f -- "$temporary_credentials"
    fail 'could not generate an OpenCode Web credential'
  fi
  chmod 0600 "$temporary_credentials"
  mv -- "$temporary_credentials" "$credentials_file"
fi
[[ -f "$credentials_file" && ! -L "$credentials_file" ]] || fail "unsafe credential file: $credentials_file"
[[ "$(stat -c %a "$credentials_file")" = 600 ]] || \
  fail "credential file must have mode 0600: $credentials_file"
mapfile -t credentials <"$credentials_file"
[[ "${#credentials[@]}" = 2 && "${credentials[0]}" = "$SERVER_USERNAME" && \
  "${credentials[1]}" =~ ^[A-Za-z0-9_-]{32}$ ]] || fail "invalid credential file: $credentials_file"
password="${credentials[1]}"

process_start_time() {
  node - "$1" <<'NODE'
const fs = require("node:fs")
const source = fs.readFileSync(`/proc/${process.argv[2]}/stat`, "utf8")
const fields = source.slice(source.lastIndexOf(")") + 2).trim().split(/\s+/)
process.stdout.write(fields[19])
NODE
}

process_instance_matches() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs")
const expected = `DIM_OPENCODE_WEB_INSTANCE_ID=${process.argv[3]}`
const environment = fs.readFileSync(`/proc/${process.argv[2]}/environ`, "utf8").split("\0")
process.exit(environment.includes(expected) ? 0 : 1)
NODE
}

process_owns_listener() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs")
const [pid, portText] = process.argv.slice(2)
const port = Number.parseInt(portText, 10).toString(16).toUpperCase().padStart(4, "0")
const listening = new Set()
for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
  for (const line of fs.readFileSync(table, "utf8").trim().split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields[1]?.endsWith(`:${port}`) && fields[3] === "0A" && fields[9]) listening.add(fields[9])
  }
}
for (const entry of fs.readdirSync(`/proc/${pid}/fd`)) {
  let target
  try { target = fs.readlinkSync(`/proc/${pid}/fd/${entry}`) } catch { continue }
  const match = /^socket:\[(\d+)\]$/.exec(target)
  if (match && listening.has(match[1])) process.exit(0)
}
process.exit(1)
NODE
}

stop_process() {
  local process_id="$1"
  kill "$process_id" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$process_id" 2>/dev/null || { wait "$process_id" 2>/dev/null || true; return 0; }
    sleep 0.1
  done
  kill -KILL "$process_id" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$process_id" 2>/dev/null || { wait "$process_id" 2>/dev/null || true; return 0; }
    sleep 0.1
  done
  return 1
}

authenticated_health() {
  local response unauthenticated_status
  unauthenticated_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 1 \
    "http://127.0.0.1:$port/global/health" 2>/dev/null)" || return 1
  [[ "$unauthenticated_status" = 401 ]] || return 1
  response="$(printf 'user = "%s:%s"\n' "$SERVER_USERNAME" "$password" |
    curl --config - --fail --silent --show-error --connect-timeout 1 --max-time 1 \
      "http://127.0.0.1:$port/global/health" 2>/dev/null)" || return 1
  jq -e '.healthy == true' >/dev/null 2>&1 <<<"$response"
}

owned_pid=""
if [[ -f "$pid_file" && ! -L "$pid_file" ]]; then
  read -r recorded_pid recorded_start recorded_port recorded_instance extra <"$pid_file" || true
  if [[ "${recorded_pid:-}" =~ ^[0-9]+$ && "${recorded_start:-}" =~ ^[0-9]+$ && \
    "${recorded_instance:-}" =~ ^[a-f0-9]{64}$ && -z "${extra:-}" && \
    -r "/proc/$recorded_pid/stat" && "$(process_start_time "$recorded_pid")" = "$recorded_start" && \
    "${recorded_port:-}" =~ ^[0-9]+$ ]] && \
    process_instance_matches "$recorded_pid" "$recorded_instance"; then
    owned_pid="$recorded_pid"
    if [[ "${recorded_port:-}" = "$port" ]] && authenticated_health && \
      process_owns_listener "$owned_pid" "$port"; then
      server_pid="$owned_pid"
    else
      stop_process "$owned_pid" || fail "owned OpenCode Web process did not stop: $owned_pid"
      owned_pid=""
      rm -f -- "$pid_file"
    fi
  else
    rm -f -- "$pid_file"
  fi
fi

started_pid=""
launch_complete=false
cleanup_started_process() {
  local status=$?
  if [[ "$launch_complete" = false && -n "$started_pid" ]]; then
    stop_process "$started_pid" || printf 'opencode-web: could not stop failed OpenCode Web process: %s\n' "$started_pid" >&2
    rm -f -- "$pid_file"
  fi
  return "$status"
}
trap cleanup_started_process EXIT
trap 'exit 130' HUP INT TERM

if [[ -z "${server_pid:-}" ]]; then
  : >"$log_file"
  chmod 0600 "$log_file"
  instance_id="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  OPENCODE_SERVER_USERNAME="$SERVER_USERNAME" \
  OPENCODE_SERVER_PASSWORD="$password" \
  DIM_OPENCODE_WEB_INSTANCE_ID="$instance_id" \
    nohup opencode web --hostname 0.0.0.0 --port "$port" \
      {lock_fd}>&- </dev/null >>"$log_file" 2>&1 &
  server_pid=$!
  started_pid="$server_pid"
  readiness_deadline=$((SECONDS + 12))
  server_ready=false
  while ((SECONDS < readiness_deadline)); do
    if authenticated_health && process_owns_listener "$server_pid" "$port"; then
      kill -0 "$server_pid" 2>/dev/null || \
        fail "OpenCode Web exited before becoming ready; inspect $log_file"
      server_ready=true
      break
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      wait "$server_pid" 2>/dev/null || true
      fail "OpenCode Web exited before becoming ready; inspect $log_file"
    fi
    sleep 0.1
  done
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid" 2>/dev/null || true
    fail "OpenCode Web exited before becoming ready; inspect $log_file"
  fi
  [[ "$server_ready" = true ]] || \
    fail "OpenCode Web did not own its listening socket before the readiness deadline; inspect $log_file"
  printf '%s %s %s %s\n' "$server_pid" "$(process_start_time "$server_pid")" "$port" "$instance_id" >"$pid_file"
  chmod 0600 "$pid_file"
fi

urls="$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 --unix-socket "$controller_socket" \
  http://dim-controller/api/urls)" || fail 'could not list external URLs'
external_url="$(jq -r --arg ingress "$ingress" --argjson port "$port" \
  --argjson containers "$containers_json" '
    .urls[]? |
    select(.ingress == $ingress and .target.protocol == "http" and
      .target.port == $port and .target.containers == $containers) |
    .url
  ' <<<"$urls" | sed -n '1p')"

if [[ -z "$external_url" ]]; then
  request_body="$(jq -cn --arg ingress "$ingress" --argjson port "$port" \
    --argjson containers "$containers_json" \
    '{ingress:$ingress,target:{containers:$containers,port:$port,protocol:"http"}}')"
  response="$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 --unix-socket "$controller_socket" \
    --header 'Content-Type: application/json' --data "$request_body" \
    http://dim-controller/api/urls)" || fail 'could not request an external URL'
  external_url="$(jq -er '.urls[0].url // .url' <<<"$response")" || fail 'external URL response did not contain a URL'
fi
[[ "$external_url" =~ ^https://[^[:space:]]+$ ]] || fail 'external URL response did not contain a valid HTTPS URL'

launch_complete=true
printf 'url: %s\nusername: %s\ncredentials: %s\n' "$external_url" "$SERVER_USERNAME" "$credentials_file"
printf 'opencode-web: process %s; credentials %s; log %s\n' \
  "$server_pid" "$credentials_file" "$log_file" >&2
