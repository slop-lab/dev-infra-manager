#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-opencode-web-real.XXXXXX)"
pid_file="$work_dir/home/.local/state/opencode-web/server.pid"
cleanup() {
  local status=$?
  if [[ -f "$pid_file" ]]; then
    node - "$pid_file" <<'NODE'
const fs = require("node:fs");
const [pidText, start, , instance] = fs.readFileSync(process.argv[2], "utf8").trim().split(/\s+/);
if (!/^[1-9][0-9]*$/.test(pidText)) throw new Error("invalid disposable server PID");
const pid = Number(pidText);
try {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const actualStart = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  if (actualStart !== start || !env.includes(`DIM_OPENCODE_WEB_INSTANCE_ID=${instance}`)) {
    throw new Error("disposable server identity changed; refusing cleanup");
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 3_000;
  const check = () => {
    try {
      const current = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = current.slice(current.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (fields[19] !== start || fields[0] === "Z") return;
      if (Date.now() >= deadline) throw new Error("disposable server did not stop; fixture retained");
      setTimeout(check, 50);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  check();
} catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
NODE
  fi
  rm -rf -- "$work_dir"
  return "$status"
}
trap cleanup EXIT

find_opencode() {
  local candidate
  for candidate in "${OPENCODE_REAL_BINARY:-}" "$HOME/.local/bin/opencode" "$HOME/.opencode/bin/opencode"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    [[ "$("$candidate" --version)" = 1.18.31 ]] && { printf '%s\n' "$candidate"; return; }
  done
  mkdir -p "$work_dir/install-home"
  HOME="$work_dir/install-home" bash "$repo_root/scripts/workspace-user-setup.bash" >/dev/null
  printf '%s\n' "$work_dir/install-home/.local/bin/opencode"
}

opencode_binary="$(find_opencode)"
mkdir -p "$work_dir/home" "$work_dir/tools"
ln -s "$opencode_binary" "$work_dir/tools/opencode"
port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
run_launcher() {
  HOME="$work_dir/home" PATH="$work_dir/tools:$PATH" OPENCODE_WEB_PORT="$port" \
    bash "$repo_root/scripts/opencode-web.bash"
}
output="$(run_launcher)"
grep -Fqx "url: http://127.0.0.1:$port" <<<"$output"
credentials="$work_dir/home/.local/state/opencode-web/credentials"
password="$(sed -n '2p' "$credentials")"
[[ "$(stat -c %a "$credentials")" = 600 ]]
[[ "$output" != *"$password"* ]]
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/global/health")" = 401 ]]
printf 'user = "opencode:%s"\n' "$password" |
  curl --config - --fail --silent --show-error "http://127.0.0.1:$port/global/health" | jq -e '.healthy == true' >/dev/null
before="$(cat "$pid_file")"
[[ "$(run_launcher)" = "$output" ]]
[[ "$(cat "$pid_file")" = "$before" ]]
printf '%s\n' opencode-web-real-runtime-smoke-ok
