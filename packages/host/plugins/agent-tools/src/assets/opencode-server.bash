#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_OPENCODE_VERSION="1.18.31"
readonly DEFAULT_PORT="4096"
readonly SERVER_USERNAME="opencode"

fail() {
  printf 'opencode-web: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found on PATH: $1"
}

operation="start"
json_output=false
operation_selected=false
for argument in "$@"; do
  case "$argument" in
    start|status|stop|credentials|password) [[ "$operation_selected" = false ]] || fail 'specify one operation'; operation="$argument"; operation_selected=true ;;
    --json) json_output=true ;;
    *) fail 'usage: opencode-server.bash [start|status|stop|credentials|password] [--json]' ;;
  esac
done
for command_name in curl flock jq node base64; do
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
state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
state_dir="$(node - "$HOME" "$state_home" "$operation" <<'NODE'
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
    if (!["start", "password"].includes(process.argv[4])) {
      process.stdout.write(path.join(home, relative, "opencode-web"))
      process.exit(0)
    }
    fs.mkdirSync(current, { mode: 0o700 })
  }
  const canonical = fs.realpathSync(current)
  const canonicalRelative = path.relative(home, canonical)
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new Error(`state directory escapes HOME: ${current}`)
  }
  current = canonical
}
if (fs.statSync(current).uid !== process.getuid()) throw new Error("state directory must be user-owned")
process.stdout.write(current)
NODE
)" || fail 'could not create a safe OpenCode Web state directory below HOME'

umask 077
lock_file="$state_dir/launch.lock"
credentials_file="$state_dir/credentials"
pid_file="$state_dir/server.pid"
log_file="$state_dir/server.log"

for state_file in "$lock_file" "$credentials_file" "$pid_file" "$log_file"; do
  [[ ! -L "$state_file" && (! -e "$state_file" || ( -f "$state_file" && -O "$state_file" )) ]] || \
    fail "unsafe state file: $state_file"
done

print_result() {
  local state="$1"
  if [[ "$json_output" = true ]]; then
    node - "$state" "$port" "$credentials_file" "$log_file" <<'NODE'
const [state, port, credentialsFile, logFile] = process.argv.slice(2)
console.log(JSON.stringify({state, port: Number(port), url: `http://127.0.0.1:${port}`, username: "opencode", credentialsFile, logFile}))
NODE
  else
    printf 'state: %s\nurl: %s\nusername: %s\ncredentials: %s\n' "$state" "http://127.0.0.1:$port" "$SERVER_USERNAME" "$credentials_file"
  fi
}
if [[ "$operation" = credentials && ! -d "$state_dir" ]]; then
  fail "OpenCode credentials have not been configured; start the server or set a password first"
fi
if [[ "$operation" != start && "$operation" != password && ! -d "$state_dir" ]]; then
  print_result stopped
  exit 0
fi
chmod 0700 "$state_dir"

exec {lock_fd}>"$lock_file"
flock --wait 5 "$lock_fd" || fail 'timed out waiting for the launch lock'

if [[ "$operation" = start && ! -e "$credentials_file" ]]; then
  temporary_credentials="$(mktemp "$state_dir/.credentials.XXXXXX")"
  if ! node -e 'process.stdout.write(`opencode\n${require("node:crypto").randomBytes(24).toString("base64url")}\n`)' \
    >"$temporary_credentials"; then
    rm -f -- "$temporary_credentials"
    fail 'could not generate an OpenCode Web credential'
  fi
  chmod 0600 "$temporary_credentials"
  mv -- "$temporary_credentials" "$credentials_file"
fi
password=""
if [[ -e "$credentials_file" ]]; then
  [[ -f "$credentials_file" && ! -L "$credentials_file" ]] || fail "unsafe credential file: $credentials_file"
  [[ "$(stat -c %a "$credentials_file")" = 600 ]] || \
    fail "credential file must have mode 0600: $credentials_file"
  mapfile -t credentials <"$credentials_file"
  node - "$credentials_file" <<'NODE' || fail 'invalid credential file'
const fs = require("node:fs")
const file = process.argv[2], stat = fs.statSync(file)
const lines = fs.readFileSync(file, "utf8").split("\n")
if (stat.nlink !== 1 || lines.length !== 3 || lines[0] !== "opencode" || lines[2] !== "" || !/^[\x20-\x7e]{12,128}$/.test(lines[1])) process.exit(1)
NODE
  password="${credentials[1]}"
fi

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

process_configuration_matches() {
  local process_id="$1"
  local key="$2"
  local value="$3"
  node - "$process_id" "$key" "$value" <<'NODE'
const fs = require("node:fs")
const expected = `${process.argv[3]}=${process.argv[4]}`
const environment = fs.readFileSync(`/proc/${process.argv[2]}/environ`, "utf8").split("\0")
process.exit(environment.includes(expected) ? 0 : 1)
NODE
}

process_cors_matches() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs")
const expected = `DIM_OPENCODE_WEB_CORS_ORIGINS_CANONICAL=${process.argv[3]}`
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

process_is_same_live_instance() {
  node - "$1" "$2" "$3" <<'NODE'
const fs = require("node:fs")
try {
  const source = fs.readFileSync(`/proc/${process.argv[2]}/stat`, "utf8")
  const fields = source.slice(source.lastIndexOf(")") + 2).trim().split(/\s+/)
  const environment = fs.readFileSync(`/proc/${process.argv[2]}/environ`, "utf8").split("\0")
  process.exit(fields[0] !== "Z" && fields[19] === process.argv[3] && environment.includes(`DIM_OPENCODE_WEB_INSTANCE_ID=${process.argv[4]}`) ? 0 : 1)
} catch { process.exit(1) }
NODE
}

stop_process() {
  local process_id="$1" expected_start="$2" expected_instance="$3"
  process_is_same_live_instance "$process_id" "$expected_start" "$expected_instance" || return 0
  kill "$process_id" 2>/dev/null || true
  for _ in $(seq 1 20); do
    process_is_same_live_instance "$process_id" "$expected_start" "$expected_instance" || { wait "$process_id" 2>/dev/null || true; return 0; }
    sleep 0.1
  done
  process_is_same_live_instance "$process_id" "$expected_start" "$expected_instance" || return 0
  kill -KILL "$process_id" 2>/dev/null || true
  for _ in $(seq 1 20); do
    process_is_same_live_instance "$process_id" "$expected_start" "$expected_instance" || { wait "$process_id" 2>/dev/null || true; return 0; }
    sleep 0.1
  done
  return 1
}

authenticated_health() {
  local response unauthenticated_status
  unauthenticated_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 1 \
    "http://127.0.0.1:$port/global/health" 2>/dev/null)" || return 1
  [[ "$unauthenticated_status" = 401 ]] || return 1
  response="$(printf 'header = "Authorization: Basic %s"\n' "$(printf '%s:%s' "$SERVER_USERNAME" "$password" | base64 -w0)" |
    curl --config - --fail --silent --show-error --connect-timeout 1 --max-time 1 \
      "http://127.0.0.1:$port/global/health" 2>/dev/null)" || return 1
  jq -e '.healthy == true' >/dev/null 2>&1 <<<"$response"
}

# Only this explicit operation discloses a credential; status and logs never do.
if [[ "$operation" = credentials ]]; then
  [[ -n "$password" ]] || fail 'OpenCode credentials have not been configured'
  node - "$credentials_file" <<'NODE'
const fs = require("node:fs")
const [username, password] = fs.readFileSync(process.argv[2], "utf8").split("\n")
console.log(JSON.stringify({username, password}))
NODE
  exit 0
fi

# Inspection never evaluates integration hooks, installs tools, or creates credentials.
if [[ "$operation" != start ]]; then
  owned_pid=""
  if [[ -f "$pid_file" ]]; then
    read -r recorded_pid recorded_start recorded_port recorded_instance extra <"$pid_file" || true
    if [[ "${recorded_pid:-}" =~ ^[0-9]+$ && "${recorded_start:-}" =~ ^[0-9]+$ &&
      "${recorded_instance:-}" =~ ^[a-f0-9]{64}$ && -z "${extra:-}" &&
      "${recorded_port:-}" = "$port" && -r "/proc/$recorded_pid/stat" ]] &&
      [[ "$(process_start_time "$recorded_pid" 2>/dev/null)" = "$recorded_start" ]] &&
      process_instance_matches "$recorded_pid" "$recorded_instance" 2>/dev/null &&
      process_owns_listener "$recorded_pid" "$port" 2>/dev/null; then
      owned_pid="$recorded_pid"
    fi
  fi
  if [[ "$operation" = password ]]; then
    temporary_credentials="$(mktemp "$state_dir/.credentials.XXXXXX")"
    if ! node -e '
const fs = require("node:fs")
let bytes = 0; const chunks = []
process.stdin.on("data", chunk => { bytes += chunk.length; if (bytes > 4096) process.exit(1); chunks.push(chunk) })
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.password !== "string" || !/^[\x20-\x7e]{12,128}$/.test(value.password)) throw Error("invalid")
    fs.writeFileSync(process.argv[1], `opencode\n${value.password}\n`, {mode: 0o600})
  } catch { process.exitCode = 1 }
})' "$temporary_credentials"; then
      rm -f -- "$temporary_credentials"
      fail 'password must contain 12–128 printable ASCII characters'
    fi
    if [[ -n "$owned_pid" ]]; then
      stop_process "$owned_pid" "$recorded_start" "$recorded_instance" || { rm -f -- "$temporary_credentials"; fail 'owned OpenCode Web process did not stop'; }
      rm -f -- "$pid_file"
    fi
    mv -- "$temporary_credentials" "$credentials_file"
    mapfile -t credentials <"$credentials_file"
    password="${credentials[1]}"
    if [[ -n "$owned_pid" ]]; then operation=start; else print_result stopped; exit 0; fi
  fi
  if [[ "$operation" = stop && -n "$owned_pid" ]]; then
    stop_process "$owned_pid" "$recorded_start" "$recorded_instance" || fail 'owned OpenCode Web process did not stop'
    rm -f -- "$pid_file"
    owned_pid=""
  fi
  if [[ "$operation" != start ]]; then
    if [[ -n "$owned_pid" && -n "$password" ]] && authenticated_health; then
      print_result running
    else
      print_result stopped
    fi
    exit 0
  fi
fi
require_command nohup
require_command opencode
cors_origins_json="$(node - "${OPENCODE_WEB_CORS_ORIGINS:-[]}" <<'NODE' 2>/dev/null
const mandatoryOrigin = "https://slop-lab.github.io"
const input = JSON.parse(process.argv[2])
if (!Array.isArray(input)) throw new Error("origins must be an array")
const origins = new Set([mandatoryOrigin])
for (const value of input) {
  if (typeof value !== "string" || value.includes("*") ||
      !/^https?:\/\/[^/?#]+\/?$/.test(value) || /[\r\n]/.test(value)) {
    throw new Error("each origin must be an exact URL origin")
  }
  const url = new URL(value)
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" || url.password !== "" || url.pathname !== "/" ||
      url.search !== "" || url.hash !== "" || url.origin === "null" || url.origin.includes("*")) {
    throw new Error("each origin must be an exact HTTP or HTTPS URL origin")
  }
  origins.add(url.origin)
}
process.stdout.write(JSON.stringify([...origins].sort()))
NODE
)" || fail 'OPENCODE_WEB_CORS_ORIGINS must be a JSON array of exact HTTP or HTTPS origins without wildcard, userinfo, path, query, or fragment'
mapfile -t cors_origins < <(jq -r '.[]' <<<"$cors_origins_json")
cors_arguments=()
for cors_origin in "${cors_origins[@]}"; do
  cors_arguments+=(--cors "$cors_origin")
done
temp_root="${DIM_WORKSPACE_TMPDIR:-$HOME/.local/tmp}"
[[ "$temp_root" = /* && "$temp_root" != *$'\n'* ]] || fail 'temporary root must be an absolute path'
mkdir -p -- "$temp_root/opencode"
[[ ! -L "$temp_root" && ! -L "$temp_root/opencode" && -O "$temp_root/opencode" ]] || fail 'OpenCode temporary directory must be user-owned and not a symlink'
chmod 0700 "$temp_root/opencode"
export TMPDIR="$temp_root/opencode"

# OpenCode installs plugins at runtime through npm. Do not inherit a root-owned
# default ~/.npm left by an older image; setup already uses this private cache.
npm_cache="${NPM_CONFIG_CACHE-${npm_config_cache-$HOME/.local/share/workspace-user-setup/cache}}"
[[ "$npm_cache" = /* ]] || fail 'npm cache must be an absolute user-owned directory'
mkdir -p -- "$npm_cache"
[[ -d "$npm_cache" && ! -L "$npm_cache" && -O "$npm_cache" ]] || fail 'npm cache must be an absolute user-owned directory without a symlink'
chmod 0700 "$npm_cache"
export NPM_CONFIG_CACHE="$npm_cache" npm_config_cache="$npm_cache"

installed_version="$(opencode --version)"
[[ "$installed_version" = "$EXPECTED_OPENCODE_VERSION" ]] || \
  fail "expected opencode $EXPECTED_OPENCODE_VERSION; run workspace-user-setup.bash first (found $installed_version)"

# Optional user-side integration hook; no host plugin or host credential is loaded.
hook_file="$HOME/.config/dim/opencode-launch.js"
if [[ -e "$hook_file" || -L "$hook_file" ]]; then
  [[ -f "$hook_file" && ! -L "$hook_file" && -O "$hook_file" ]] || fail 'OpenCode launch hook must be an owned regular file'
  launch_environment="$(node "$hook_file")" || fail 'OpenCode launch integration failed'
  jq -e 'type == "object" and all(to_entries[]; (.key == "OPENCODE_CONFIG_CONTENT" or .key == "OMO_PROFILE") and (.value | type == "string"))' >/dev/null <<<"$launch_environment" || fail 'invalid OpenCode launch environment'
  if jq -e 'has("OPENCODE_CONFIG_CONTENT")' >/dev/null <<<"$launch_environment"; then
    export OPENCODE_CONFIG_CONTENT="$(jq -r '.OPENCODE_CONFIG_CONTENT' <<<"$launch_environment")"
  fi
  if jq -e 'has("OMO_PROFILE")' >/dev/null <<<"$launch_environment"; then
    export OMO_PROFILE="$(jq -r '.OMO_PROFILE' <<<"$launch_environment")"
  fi
fi
configuration_fingerprint="$(node --input-type=commonjs <<'NODE'
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto")
const home = process.env.HOME
const hash = crypto.createHash("sha256")
for (const key of ["DIM_LLM_ROUTER_OPENCODE_MODE", "DIM_LLM_ROUTER_CONNECTION_FILE", "OPENCODE_CONFIG_CONTENT", "OMO_PROFILE", "OCX_PROFILE", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "NPM_CONFIG_CACHE", "npm_config_cache"]) {
  hash.update(JSON.stringify([key, process.env[key] ?? null]))
}
const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
for (const file of [process.env.DIM_LLM_ROUTER_CONNECTION_FILE || path.join(home, ".config/dim/llm-router.json"),
  path.join(home, ".config/dim/opencode-launch.js"), path.join(config, "opencode/plugins/dim-llm-router.js"),
  path.join(config, "opencode/opencode.json"), path.join(config, "opencode/opencode.jsonc"),
  path.join(home, ".omo/omo.jsonc"), process.env.OPENCODE_CONFIG].filter(Boolean)) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size > 1024 * 1024) throw Error("unsafe OpenCode integration configuration")
    hash.update(file).update(fs.readFileSync(file))
  } catch (error) { if (error.code !== "ENOENT") throw error }
}
process.stdout.write(hash.digest("hex"))
NODE
)" || fail 'could not fingerprint OpenCode configuration'


owned_pid=""
if [[ -f "$pid_file" && ! -L "$pid_file" ]]; then
  read -r recorded_pid recorded_start recorded_port recorded_instance extra <"$pid_file" || true
  if [[ "${recorded_pid:-}" =~ ^[0-9]+$ && "${recorded_start:-}" =~ ^[0-9]+$ && \
    "${recorded_instance:-}" =~ ^[a-f0-9]{64}$ && -z "${extra:-}" && \
    -r "/proc/$recorded_pid/stat" && "$(process_start_time "$recorded_pid")" = "$recorded_start" && \
    "${recorded_port:-}" =~ ^[0-9]+$ ]] && \
    process_instance_matches "$recorded_pid" "$recorded_instance"; then
    owned_pid="$recorded_pid"
    if [[ "${recorded_port:-}" = "$port" ]] && process_cors_matches "$owned_pid" "$cors_origins_json" && \
      process_configuration_matches "$owned_pid" DIM_OPENCODE_WEB_CONFIGURATION_FINGERPRINT "$configuration_fingerprint" && \
      authenticated_health && \
      process_owns_listener "$owned_pid" "$port"; then
      server_pid="$owned_pid"
    else
      stop_process "$owned_pid" "$recorded_start" "$recorded_instance" || fail "owned OpenCode Web process did not stop: $owned_pid"
      owned_pid=""
      rm -f -- "$pid_file"
    fi
  else
    rm -f -- "$pid_file"
  fi
fi

started_pid=""
started_start=""
launch_complete=false
cleanup_started_process() {
  local status=$?
  if [[ "$launch_complete" = false && -n "$started_pid" ]]; then
    stop_process "$started_pid" "$started_start" "$instance_id" || printf 'opencode-web: could not stop failed OpenCode Web process: %s\n' "$started_pid" >&2
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
  DIM_OPENCODE_WEB_CORS_ORIGINS_CANONICAL="$cors_origins_json" \
  DIM_OPENCODE_WEB_CONFIGURATION_FINGERPRINT="$configuration_fingerprint" \
    nohup opencode serve --hostname 127.0.0.1 --port "$port" \
      "${cors_arguments[@]}" \
      {lock_fd}>&- </dev/null >>"$log_file" 2>&1 &
  server_pid=$!
  started_pid="$server_pid"
  started_start="$(process_start_time "$server_pid" 2>/dev/null)" || fail 'OpenCode Web exited during launch'
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

launch_complete=true
print_result running
if [[ "$json_output" != true ]]; then
  printf 'opencode-web: process %s; credentials %s; log %s\n' \
    "$server_pid" "$credentials_file" "$log_file" >&2
  printf 'Open https://slop-lab.github.io/dev-infra-manager/opencode-web/ and add your approved HTTPS server, or forward locally with: dim forward WORKSPACE %s:%s\n' "$port" "$port" >&2
fi
