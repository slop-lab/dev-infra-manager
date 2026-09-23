#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
setup_script="$repo_root/scripts/workspace-user-setup.bash"
assertions="$script_dir/lib/workspace-user-setup-assertions.cjs"
faults="$script_dir/lib/workspace-user-setup-faults.cjs"
work_dir="$(mktemp -d /tmp/dim-workspace-user-setup.XXXXXX)"
system_path="$PATH"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

export HOME="$work_dir/home"
export XDG_CONFIG_HOME="$HOME/.config"
export GIT_CONFIG_GLOBAL="$HOME/.config/git/config"
export GIT_CONFIG_NOSYSTEM=1
export NPM_CONFIG_USERCONFIG="$work_dir/outside-npm/npmrc"
export NPM_CONFIG_CACHE="$work_dir/outside-npm/cache"
unset XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME NODE_OPTIONS WORKSPACE_USER_SETUP_FAULT
mkdir -p "$XDG_CONFIG_HOME/opencode" "$HOME/.omo" "$(dirname -- "$GIT_CONFIG_GLOBAL")" \
  "$HOME/.cache"

printf '%s\n' \
  '[user]' \
  '  name = Workspace Setup Smoke' \
  '  email = workspace-setup@dim.invalid' \
  >"$GIT_CONFIG_GLOBAL"
cat >"$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<'EOF'
{
  // OpenCode fixture comment must survive targeted edits.
  "theme"  :  "dim-smoke",
  "nested": { "keep": true },
  "plugin": [
    "example-plugin@2.0.0",
    ["oh-my-opencode@0.0.1", { "preserve": "plugin-options" }],
  ],
}
EOF

cat >"$HOME/.omo/omo.jsonc" <<'EOF'
{
  // OMO fixture comment must survive targeted edits.
  "unrelated": { "keep": true },
  "[opencode]": {
    "channel" : "stable",
    "auto_update": true,
    "team_mode": {
      "label": "preserved",
      "enabled": false,
    },
  },
}
EOF

assert_no_opencode_runtime() {
  node - "$HOME/.local" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const installPrefix = process.argv[2]
const listeningSockets = new Set()
for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
  for (const row of fs.readFileSync(table, "utf8").trim().split("\n").slice(1)) {
    const columns = row.trim().split(/\s+/)
    if (columns[3] === "0A") listeningSockets.add(columns[9])
  }
}
for (const processId of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
  let commandLine
  try {
    commandLine = fs.readFileSync(path.join("/proc", processId, "cmdline"), "utf8").replaceAll("\0", " ")
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") continue
    throw error
  }
  if (!commandLine.includes(installPrefix) || !commandLine.includes("opencode")) continue
  const descriptors = fs.readdirSync(path.join("/proc", processId, "fd"))
  const ownsListener = descriptors.some((descriptor) => {
    const target = fs.readlinkSync(path.join("/proc", processId, "fd", descriptor))
    const match = /^socket:\[(\d+)\]$/.exec(target)
    return match !== null && listeningSockets.has(match[1])
  })
  throw new Error(`OpenCode process remained after setup (pid ${processId}, listener ${ownsListener})`)
}
NODE
}

assert_rejected_config_home() {
  local test_home="$1"
  local config_home="$2"
  local marker="$3"
  mkdir -p "$test_home"
  if env HOME="$test_home" XDG_CONFIG_HOME="$config_home" PATH="$work_dir/reject-tools:$system_path" \
    NPM_INVOCATION_MARKER="$marker" bash "$setup_script" >/dev/null 2>&1; then
    echo "workspace setup unexpectedly accepted unsafe configuration path: $config_home" >&2
    exit 1
  fi
  if [[ -e "$marker" ]]; then
    echo "npm was invoked before unsafe configuration path rejection: $config_home" >&2
    exit 1
  fi
}

assert_rejected_cache_home() {
  local test_home="$1"
  local cache_home="$2"
  local marker="$3"
  mkdir -p "$test_home"
  if env -u XDG_DATA_HOME -u XDG_STATE_HOME HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" \
    XDG_CACHE_HOME="$cache_home" \
    PATH="$work_dir/reject-tools:$system_path" NPM_INVOCATION_MARKER="$marker" \
    bash "$setup_script" >/dev/null 2>&1; then
    echo "workspace setup unexpectedly accepted unsafe cache path: $cache_home" >&2
    exit 1
  fi
  if [[ -e "$marker" ]]; then
    echo "npm was invoked before unsafe cache path rejection: $cache_home" >&2
    exit 1
  fi
}

assert_rejected_default_cache_home() {
  local test_home="$1"
  local marker="$2"
  mkdir -p "$test_home"
  if env -u XDG_CACHE_HOME HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" \
    PATH="$work_dir/reject-tools:$system_path" NPM_INVOCATION_MARKER="$marker" \
    bash "$setup_script" >/dev/null 2>&1; then
    echo "workspace setup unexpectedly accepted unsafe default cache path" >&2
    exit 1
  fi
  if [[ -e "$marker" ]]; then
    echo "npm was invoked before unsafe default cache path rejection" >&2
    exit 1
  fi
}

assert_accepted_cache_home() {
  local test_home="$1"
  local cache_home="$2"
  local expected_cache_home="$3"
  local marker="$4"
  local coordinate
  mkdir -p "$test_home"
  if env HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" XDG_CACHE_HOME="$cache_home" \
    PATH="$work_dir/reject-tools:$system_path" NPM_INVOCATION_MARKER="$marker" \
    bash "$setup_script" >/dev/null 2>&1; then
    echo "workspace setup unexpectedly succeeded with rejecting npm stub" >&2
    exit 1
  fi
  [[ -e "$marker" ]] || { echo "npm did not receive the contained cache path" >&2; exit 1; }
  mapfile -t recorded_paths <"$marker"
  [[ "${#recorded_paths[@]}" = 5 ]] || { echo "npm path marker did not contain five entries" >&2; exit 1; }
  [[ "${recorded_paths[0]}" = "$expected_cache_home" ]] || { echo "npm received noncanonical XDG_CACHE_HOME" >&2; exit 1; }
  [[ "${recorded_paths[1]}" = "$test_home/.local/share" ]] || { echo "npm received noncanonical default XDG_DATA_HOME" >&2; exit 1; }
  [[ "${recorded_paths[2]}" = "$test_home/.local/state" ]] || { echo "npm received noncanonical default XDG_STATE_HOME" >&2; exit 1; }
  [[ "${recorded_paths[3]}" = "$test_home/.local/share/workspace-user-setup/cache" ]] || { echo "npm received unexpected NPM_CONFIG_CACHE" >&2; exit 1; }
  [[ "${recorded_paths[4]}" = "$test_home/.local/share/workspace-user-setup/npmrc" ]] || { echo "npm received unexpected NPM_CONFIG_USERCONFIG" >&2; exit 1; }
  coordinate="$expected_cache_home/opencode/packages/oh-my-openagent@4.19.4"
  [[ ! -e "$coordinate" && ! -L "$coordinate" ]] || { echo "valid preflight created the OMO cache coordinate" >&2; exit 1; }
}

assert_rejected_xdg_home() {
  local variable="$1"
  local test_home="$2"
  local value="$3"
  local name="$4"
  local marker="$work_dir/$name-npm-invoked"
  mkdir -p "$test_home"
  if env -u XDG_DATA_HOME -u XDG_STATE_HOME HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" \
    "$variable=$value" PATH="$work_dir/reject-tools:$system_path" NPM_INVOCATION_MARKER="$marker" \
    bash "$setup_script" >/dev/null 2>&1; then
    echo "workspace setup unexpectedly accepted unsafe $variable: $value" >&2
    exit 1
  fi
  if [[ -e "$marker" ]]; then
    echo "npm was invoked before unsafe $variable rejection: $value" >&2
    exit 1
  fi
}

assert_accepted_xdg_home() {
  local variable="$1"
  local test_home="$2"
  local value="$3"
  local expected_data_home="$4"
  local expected_state_home="$5"
  local name="$6"
  local marker="$work_dir/$name-npm-invoked"
  mkdir -p "$test_home"
  if env -u XDG_DATA_HOME -u XDG_STATE_HOME HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" \
    "$variable=$value" PATH="$work_dir/reject-tools:$system_path" NPM_INVOCATION_MARKER="$marker" \
    bash "$setup_script" >/dev/null 2>&1; then
    echo "workspace setup unexpectedly succeeded with rejecting npm stub" >&2
    exit 1
  fi
  [[ -e "$marker" ]] || { echo "npm did not receive accepted $variable" >&2; exit 1; }
  mapfile -t recorded_paths <"$marker"
  [[ "${#recorded_paths[@]}" = 5 ]] || { echo "npm path marker did not contain five entries" >&2; exit 1; }
  [[ "${recorded_paths[0]}" = "$test_home/.cache" ]] || { echo "npm received noncanonical XDG_CACHE_HOME" >&2; exit 1; }
  [[ "${recorded_paths[1]}" = "$expected_data_home" ]] || { echo "npm received noncanonical XDG_DATA_HOME" >&2; exit 1; }
  [[ "${recorded_paths[2]}" = "$expected_state_home" ]] || { echo "npm received noncanonical XDG_STATE_HOME" >&2; exit 1; }
  [[ "${recorded_paths[3]}" = "$test_home/.local/share/workspace-user-setup/cache" ]] || { echo "npm received unexpected NPM_CONFIG_CACHE" >&2; exit 1; }
  [[ "${recorded_paths[4]}" = "$test_home/.local/share/workspace-user-setup/npmrc" ]] || { echo "npm received unexpected NPM_CONFIG_USERCONFIG" >&2; exit 1; }
}

assert_rejected_cache_descendant() {
  local descendant="$1"
  local name="${descendant//\//-}"
  local test_home="$work_dir/cache-escape-home-$name"
  local outside="$work_dir/cache-escape-outside-$name"
  local marker="$work_dir/cache-escape-marker-$name"
  mkdir -p "$test_home/.cache/$(dirname -- "$descendant")" "$outside"
  printf '%s\n' outside-sentinel >"$outside/sentinel"
  ln -s "$outside" "$test_home/.cache/$descendant"
  if env -u XDG_CACHE_HOME HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" \
    PATH="$work_dir/reject-tools:$system_path" NPM_INVOCATION_MARKER="$marker" \
    bash "$setup_script" >/dev/null 2>&1; then
    echo "workspace setup unexpectedly accepted escaping cache descendant: $descendant" >&2
    exit 1
  fi
  test ! -e "$marker"
  test "$(cat "$outside/sentinel")" = outside-sentinel
}

assert_accepted_cache_descendant() {
  local descendant="$1"
  local name="${descendant//\//-}"
  local test_home="$work_dir/cache-contained-home-$name"
  local target="$test_home/cache-contained-target-$name"
  local marker="$work_dir/cache-contained-marker-$name"
  mkdir -p "$test_home/.cache/$(dirname -- "$descendant")" "$target"
  ln -s "$target" "$test_home/.cache/$descendant"
  if env -u XDG_CACHE_HOME HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" \
    PATH="$work_dir/reject-tools:$system_path" NPM_INVOCATION_MARKER="$marker" \
    bash "$setup_script" >/dev/null 2>&1; then
    echo "workspace setup unexpectedly succeeded with rejecting npm stub" >&2
    exit 1
  fi
  test -e "$marker"
}

assert_rejected_omo_coordinate_symlink() {
  local target_scope="$1"
  local test_home="$work_dir/omo-coordinate-$target_scope-home"
  local outside="$work_dir/omo-coordinate-$target_scope-outside"
  local marker="$work_dir/omo-coordinate-$target_scope-npm-invoked"
  local coordinate="$test_home/.cache/opencode/packages/oh-my-openagent@4.19.4"
  local target
  mkdir -p "$(dirname -- "$coordinate")"
  case "$target_scope" in
    inside)
      target="$test_home/omo-coordinate-target"
      ;;
    outside)
      target="$outside"
      ;;
    *)
      echo "unknown OMO coordinate target scope: $target_scope" >&2
      exit 1
      ;;
  esac
  mkdir -p "$target"
  printf '%s\n' "$target_scope-sentinel" >"$target/sentinel"
  ln -s "$target" "$coordinate"
  if env -u XDG_CACHE_HOME -u XDG_DATA_HOME -u XDG_STATE_HOME HOME="$test_home" \
    XDG_CONFIG_HOME="$test_home/.config" PATH="$work_dir/reject-tools:$system_path" \
    NPM_INVOCATION_MARKER="$marker" bash "$setup_script" >/dev/null 2>&1; then
    echo "workspace setup unexpectedly accepted $target_scope-HOME OMO coordinate symlink" >&2
    exit 1
  fi
  if [[ -e "$marker" ]]; then
    echo "npm was invoked before $target_scope-HOME OMO coordinate symlink rejection" >&2
    exit 1
  fi
  test "$(cat "$target/sentinel")" = "$target_scope-sentinel"
}

assert_rejected_npm_descendant() {
  local descendant="$1"
  local name="${descendant//\//-}"
  local test_home="$work_dir/npm-escape-home-$name"
  local outside="$work_dir/npm-escape-outside-$name"
  local marker="$work_dir/npm-escape-marker-$name"
  mkdir -p "$test_home/$(dirname -- "$descendant")" "$outside"
  printf '%s\n' outside-sentinel >"$outside/sentinel"
  ln -s "$outside" "$test_home/$descendant"
  if env HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" \
    PATH="$work_dir/reject-tools:$system_path" NPM_INVOCATION_MARKER="$marker" \
    bash "$setup_script" >/dev/null 2>&1; then
    echo "workspace setup unexpectedly accepted escaping npm descendant: $descendant" >&2
    exit 1
  fi
  test ! -e "$marker"
  test "$(cat "$outside/sentinel")" = outside-sentinel
}

assert_accepted_npm_descendant() {
  local descendant="$1"
  local name="${descendant//\//-}"
  local test_home="$work_dir/npm-contained-home-$name"
  local target="$test_home/npm-contained-target-$name"
  local marker="$work_dir/npm-contained-marker-$name"
  mkdir -p "$test_home/$(dirname -- "$descendant")" "$target"
  ln -s "$target" "$test_home/$descendant"
  if env HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" \
    PATH="$work_dir/reject-tools:$system_path" NPM_INVOCATION_MARKER="$marker" \
    bash "$setup_script" >/dev/null 2>&1; then
    echo "workspace setup unexpectedly succeeded with rejecting npm stub" >&2
    exit 1
  fi
  test -e "$marker"
}

wait_for_path() {
  local target="$1"
  for attempt in $(seq 1 100); do
    [[ -e "$target" ]] && return
    [[ "$attempt" -lt 100 ]] || { echo "timed out waiting for $target" >&2; exit 1; }
    sleep 0.05
  done
}

assert_no_config_temporaries() {
  local temporary
  shopt -s nullglob
  for temporary in \
    "$XDG_CONFIG_HOME/opencode"/.opencode.json.*.tmp \
    "$XDG_CONFIG_HOME/opencode"/.opencode.jsonc.*.tmp \
    "$HOME/.omo"/.omo.jsonc.*.tmp; do
    echo "workspace setup left a temporary configuration file: $temporary" >&2
    exit 1
  done
  shopt -u nullglob
}

write_preserved_fixtures() {
  cat >"$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<'EOF'
{
  // OpenCode fixture comment must survive targeted edits.
  "theme"  :  "dim-smoke",
  "nested": { "keep": true },
  "plugin": [
    "example-plugin@2.0.0",
    ["oh-my-opencode@0.0.1", { "preserve": "plugin-options" }],
  ],
}
EOF
  cat >"$HOME/.omo/omo.jsonc" <<'EOF'
{
  // OMO fixture comment must survive targeted edits.
  "unrelated": { "keep": true },
  "[opencode]": {
    "channel" : "stable",
    "auto_update": true,
    "team_mode": {
      "label": "preserved",
      "enabled": false,
    },
  },
}
EOF
}

mkdir -p "$work_dir/reject-tools"
cat >"$work_dir/reject-tools/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" \
  "$NPM_CONFIG_CACHE" "$NPM_CONFIG_USERCONFIG" >"$NPM_INVOCATION_MARKER"
exit 97
EOF
chmod 0700 "$work_dir/reject-tools/npm"

outside_home="$work_dir/outside-home"
mkdir -p "$outside_home"
printf '%s\n' outside-sentinel >"$outside_home/sentinel"
assert_rejected_config_home "$work_dir/path-home" "$outside_home" "$work_dir/outside-npm-invoked"
test "$(cat "$outside_home/sentinel")" = outside-sentinel

symlink_home="$work_dir/symlink-home"
mkdir -p "$symlink_home"
ln -s "$outside_home" "$symlink_home/.config"
assert_rejected_config_home "$symlink_home" "$symlink_home/.config" "$work_dir/symlink-npm-invoked"
test "$(cat "$outside_home/sentinel")" = outside-sentinel

assert_rejected_cache_home "$work_dir/cache-path-home" "$outside_home" \
  "$work_dir/outside-cache-npm-invoked"
test "$(cat "$outside_home/sentinel")" = outside-sentinel

cache_symlink_home="$work_dir/cache-symlink-home"
mkdir -p "$cache_symlink_home"
ln -s "$outside_home" "$cache_symlink_home/.cache"
assert_rejected_default_cache_home "$cache_symlink_home" "$work_dir/cache-symlink-npm-invoked"
test "$(cat "$outside_home/sentinel")" = outside-sentinel

contained_cache_home="$work_dir/cache-contained-home"
contained_cache_target="$contained_cache_home/cache-target"
mkdir -p "$contained_cache_home" "$contained_cache_target"
ln -s "$contained_cache_target" "$contained_cache_home/.cache"
assert_accepted_cache_home "$contained_cache_home" "$contained_cache_home/.cache" \
  "$contained_cache_target" "$work_dir/cache-contained-npm-invoked"

for variable in XDG_DATA_HOME XDG_STATE_HOME; do
  variable_name="${variable,,}"
  relative_home="$work_dir/$variable_name-relative-home"
  assert_rejected_xdg_home "$variable" "$relative_home" relative "$variable_name-relative"
  newline_home="$work_dir/$variable_name-newline-home"
  assert_rejected_xdg_home "$variable" "$newline_home" "$newline_home/line"$'\n''break' "$variable_name-newline"
  carriage_home="$work_dir/$variable_name-carriage-return-home"
  assert_rejected_xdg_home "$variable" "$carriage_home" "$carriage_home/carriage"$'\r''return' "$variable_name-carriage-return"
  outside_value_home="$work_dir/$variable_name-outside-home"
  assert_rejected_xdg_home "$variable" "$outside_value_home" "$outside_home" "$variable_name-outside"
  test "$(cat "$outside_home/sentinel")" = outside-sentinel

  escaping_home="$work_dir/$variable_name-escaping-home"
  mkdir -p "$escaping_home"
  ln -s "$outside_home" "$escaping_home/xdg"
  assert_rejected_xdg_home "$variable" "$escaping_home" "$escaping_home/xdg" "$variable_name-escaping-symlink"
  test "$(cat "$outside_home/sentinel")" = outside-sentinel

  contained_home="$work_dir/$variable_name-contained-home"
  contained_target="$contained_home/xdg-target"
  mkdir -p "$contained_home" "$contained_target"
  ln -s "$contained_target" "$contained_home/xdg"
  if [[ "$variable" = XDG_DATA_HOME ]]; then
    assert_accepted_xdg_home "$variable" "$contained_home" "$contained_home/xdg" "$contained_target" \
      "$contained_home/.local/state" "$variable_name-contained-symlink"
  else
    assert_accepted_xdg_home "$variable" "$contained_home" "$contained_home/xdg" "$contained_home/.local/share" \
      "$contained_target" "$variable_name-contained-symlink"
  fi
done

for descendant in opencode opencode/packages; do
  assert_rejected_cache_descendant "$descendant"
  assert_accepted_cache_descendant "$descendant"
done

for target_scope in inside outside; do
  assert_rejected_omo_coordinate_symlink "$target_scope"
done

for descendant in .local/bin .local/lib .local/lib/node_modules .local/libexec .local/state/dim-project-tool; do
  assert_rejected_npm_descendant "$descendant"
  assert_accepted_npm_descendant "$descendant"
done

real_npm="$(command -v npm)"
mkdir -p "$work_dir/tools"
cat >"$work_dir/tools/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" \
  "$NPM_CONFIG_CACHE" "$NPM_CONFIG_USERCONFIG" >"$HOME/.workspace-setup-npm-paths"
case "${WORKSPACE_SETUP_NPM_MODE:-skip}" in
  hold)
    touch "$WORKSPACE_SETUP_HOLD_MARKER"
    while :; do sleep 1; done
    ;;
  real)
    guard="$HOME/.workspace-setup-npm-active"
    mkdir "$guard"
    trap 'rmdir "$guard"' EXIT
    sleep 1
    "$REAL_NPM" "$@"
    ;;
  skip) ;;
  *) exit 98 ;;
esac
EOF
chmod 0700 "$work_dir/tools/npm"
export REAL_NPM="$real_npm"
export PATH="$work_dir/tools:$system_path"

owner_death_marker="$work_dir/owner-death-entered"
setsid env WORKSPACE_SETUP_NPM_MODE=hold WORKSPACE_SETUP_HOLD_MARKER="$owner_death_marker" \
  bash "$setup_script" >"$work_dir/owner-death.stdout" 2>"$work_dir/owner-death.stderr" &
owner_pid=$!
wait_for_path "$owner_death_marker"
kill -KILL -- "-$owner_pid"
wait "$owner_pid" 2>/dev/null || true
test -e "$HOME/.workspace-user-setup.lock"
test ! -s "$HOME/.workspace-user-setup.lock"

(
  cd "$repo_root/scripts"
  sha256sum --check workspace-user-setup.bash.sha256
)

git_config_before="$(sha256sum "$GIT_CONFIG_GLOBAL")"
WORKSPACE_SETUP_NPM_MODE=real bash "$setup_script" >"$work_dir/setup-one.log" &
first_pid=$!
for attempt in $(seq 1 100); do
  [[ -d "$HOME/.workspace-setup-npm-active" ]] && break
  [[ "$attempt" -lt 100 ]] || { echo "timed out waiting for first setup npm invocation" >&2; exit 1; }
  sleep 0.05
done
if WORKSPACE_SETUP_NPM_MODE=skip bash "$setup_script" >"$work_dir/setup-two.log" 2>"$work_dir/setup-two.stderr"; then
  echo "concurrent workspace setup unexpectedly bypassed the setup lock" >&2
  exit 1
fi
grep -Fq 'workspace user setup is already running' "$work_dir/setup-two.stderr"
wait "$first_pid"

test "$($HOME/.local/bin/opencode --version)" = "1.18.31"
tool_launcher="$HOME/.local/libexec/dim-project-tool-launch"
tool_manifest="$HOME/.local/state/dim-project-tool/manifest.json"
tool_executable="$HOME/.local/bin/opencode"
test "$(stat -c %a "$tool_launcher")" = 700
test "$(stat -c %a "$tool_manifest")" = 600
node - "$tool_manifest" "$tool_executable" <<'NODE'
const fs = require("node:fs")
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (manifest.contractVersion !== 1) throw new Error("unexpected contract version")
if (manifest.tool !== "opencode" || manifest.version !== "1.18.31") throw new Error("unexpected tool identity")
if (manifest.launchers?.agent?.executable !== process.argv[3]) throw new Error("unexpected agent executable")
NODE
test "$("$tool_launcher" 1 agent opencode 1.18.31 "$tool_executable" --version)" = 1.18.31
if "$tool_launcher" 2 agent opencode 1.18.31 "$tool_executable" \
  >"$work_dir/incompatible-contract.stdout" 2>"$work_dir/incompatible-contract.stderr"; then
  echo "tool launcher unexpectedly accepted an incompatible contract" >&2
  exit 1
fi
grep -Fq 'installed tool manifest is missing or incompatible' "$work_dir/incompatible-contract.stderr"
if "$tool_launcher" 1 missing opencode 1.18.31 "$tool_executable" \
  >"$work_dir/unknown-launcher.stdout" 2>"$work_dir/unknown-launcher.stderr"; then
  echo "tool launcher unexpectedly accepted an unknown launcher" >&2
  exit 1
fi
grep -Fq 'installed tool manifest is missing or incompatible' "$work_dir/unknown-launcher.stderr"

assert_launcher_rejected() {
  local name="$1"
  shift
  if "$tool_launcher" "$@" >"$work_dir/$name.stdout" 2>"$work_dir/$name.stderr"; then
    printf 'tool launcher unexpectedly accepted %s\n' "$name" >&2
    exit 1
  fi
  grep -Fq 'installed tool manifest is missing or incompatible' "$work_dir/$name.stderr"
}

manifest_backup="$work_dir/tool-manifest.json"
cp --preserve=mode "$tool_manifest" "$manifest_backup"
rm "$tool_manifest"
ln -s "$manifest_backup" "$tool_manifest"
assert_launcher_rejected manifest-symlink 1 agent opencode 1.18.31 "$tool_executable" --version
rm "$tool_manifest"
cp --preserve=mode "$manifest_backup" "$tool_manifest"

node - "$tool_manifest" <<'NODE'
const fs = require("node:fs")
const manifestPath = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
manifest.tool = "other-tool"
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
NODE
assert_launcher_rejected tool-mismatch 1 agent opencode 1.18.31 "$tool_executable" --version
cp --preserve=mode "$manifest_backup" "$tool_manifest"

node - "$tool_manifest" <<'NODE'
const fs = require("node:fs")
const manifestPath = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
manifest.version = "1.18.30"
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
NODE
assert_launcher_rejected version-mismatch 1 agent opencode 1.18.31 "$tool_executable" --version
cp --preserve=mode "$manifest_backup" "$tool_manifest"

node - "$tool_manifest" "$HOME/.local/bin/other" <<'NODE'
const fs = require("node:fs")
const manifestPath = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
manifest.launchers.agent.executable = process.argv[3]
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
NODE
assert_launcher_rejected executable-path-mismatch 1 agent opencode 1.18.31 "$tool_executable" --version
cp --preserve=mode "$manifest_backup" "$tool_manifest"

executable_backup="$work_dir/opencode-executable"
mv "$tool_executable" "$executable_backup"
cat >"$work_dir/outside-home-opencode" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' outside-home-executed
EOF
chmod 0700 "$work_dir/outside-home-opencode"
ln -s "$work_dir/outside-home-opencode" "$tool_executable"
assert_launcher_rejected outside-home-executable-symlink 1 agent opencode 1.18.31 "$tool_executable" --version
rm "$tool_executable"
mv "$executable_backup" "$tool_executable"

mv "$tool_executable" "$executable_backup"
cat >"$tool_executable" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' non-executable-ran
EOF
chmod 0600 "$tool_executable"
assert_launcher_rejected non-executable-target 1 agent opencode 1.18.31 "$tool_executable" --version
rm "$tool_executable"
mv "$executable_backup" "$tool_executable"
node "$assertions" "$HOME/.local" "$XDG_CONFIG_HOME/opencode/opencode.jsonc" \
  "$HOME/.omo/omo.jsonc" preserved >/dev/null
grep -Fqx '  // OpenCode fixture comment must survive targeted edits.' \
  "$XDG_CONFIG_HOME/opencode/opencode.jsonc"
grep -Fqx '  "theme"  :  "dim-smoke",' "$XDG_CONFIG_HOME/opencode/opencode.jsonc"
grep -Fqx '  // OMO fixture comment must survive targeted edits.' "$HOME/.omo/omo.jsonc"
grep -Fqx '    "channel" : "stable",' "$HOME/.omo/omo.jsonc"
assert_no_opencode_runtime
test "$(sha256sum "$GIT_CONFIG_GLOBAL")" = "$git_config_before"

mapfile -t npm_paths <"$HOME/.workspace-setup-npm-paths"
test "${#npm_paths[@]}" = 5
for npm_path in "${npm_paths[@]}"; do
  case "$(realpath -m "$npm_path")" in
    "$HOME"/*) ;;
    *) echo "npm state escaped HOME: $npm_path" >&2; exit 1 ;;
  esac
done
test ! -e "$work_dir/outside-npm"
test "${npm_paths[0]}" = "$HOME/.cache"
test "${npm_paths[1]}" = "$HOME/.local/share"
test "${npm_paths[2]}" = "$HOME/.local/state"
test "${npm_paths[3]}" = "$HOME/.local/share/workspace-user-setup/cache"
test "${npm_paths[4]}" = "$HOME/.local/share/workspace-user-setup/npmrc"
test "${npm_paths[0]}" != "${npm_paths[3]}"
test -d "$HOME/.local/share/workspace-user-setup/cache"
test -d "$HOME/.local/state"
test -d "$HOME/.cache/opencode"
test -d "$HOME/.cache/opencode/packages"

open_code_before="$(sha256sum "$XDG_CONFIG_HOME/opencode/opencode.jsonc")"
omo_before="$(sha256sum "$HOME/.omo/omo.jsonc")"
bash "$setup_script" >/dev/null
node "$assertions" "$HOME/.local" "$XDG_CONFIG_HOME/opencode/opencode.jsonc" \
  "$HOME/.omo/omo.jsonc" preserved >/dev/null
test "$(sha256sum "$XDG_CONFIG_HOME/opencode/opencode.jsonc")" = "$open_code_before"
test "$(sha256sum "$HOME/.omo/omo.jsonc")" = "$omo_before"

for fault in write fsync close; do
  write_preserved_fixtures
  open_code_before_failure="$(sha256sum "$XDG_CONFIG_HOME/opencode/opencode.jsonc")"
  omo_before_failure="$(sha256sum "$HOME/.omo/omo.jsonc")"
  if env NODE_OPTIONS="--require=$faults" WORKSPACE_USER_SETUP_FAULT="$fault" \
    WORKSPACE_SETUP_NPM_MODE=skip bash "$setup_script" \
    >"$work_dir/$fault.stdout" 2>"$work_dir/$fault.stderr"; then
    echo "workspace setup unexpectedly survived injected $fault failure" >&2
    exit 1
  fi
  test "$(sha256sum "$XDG_CONFIG_HOME/opencode/opencode.jsonc")" = "$open_code_before_failure"
  test "$(sha256sum "$HOME/.omo/omo.jsonc")" = "$omo_before_failure"
  assert_no_config_temporaries
  WORKSPACE_SETUP_NPM_MODE=skip bash "$setup_script" >/dev/null
  node "$assertions" "$HOME/.local" "$XDG_CONFIG_HOME/opencode/opencode.jsonc" \
    "$HOME/.omo/omo.jsonc" preserved >/dev/null
done

write_preserved_fixtures
omo_before_failure="$(sha256sum "$HOME/.omo/omo.jsonc")"
if env NODE_OPTIONS="--require=$faults" WORKSPACE_USER_SETUP_FAULT=second-rename \
  WORKSPACE_SETUP_NPM_MODE=skip bash "$setup_script" \
  >"$work_dir/second-rename.stdout" 2>"$work_dir/second-rename.stderr"; then
  echo "workspace setup unexpectedly survived injected second rename failure" >&2
  exit 1
fi
grep -Fq '"autoupdate": false' "$XDG_CONFIG_HOME/opencode/opencode.jsonc"
test "$(sha256sum "$HOME/.omo/omo.jsonc")" = "$omo_before_failure"
assert_no_config_temporaries
WORKSPACE_SETUP_NPM_MODE=skip bash "$setup_script" >/dev/null
node "$assertions" "$HOME/.local" "$XDG_CONFIG_HOME/opencode/opencode.jsonc" \
  "$HOME/.omo/omo.jsonc" preserved >/dev/null
open_code_after_retry="$(sha256sum "$XDG_CONFIG_HOME/opencode/opencode.jsonc")"
omo_after_retry="$(sha256sum "$HOME/.omo/omo.jsonc")"
WORKSPACE_SETUP_NPM_MODE=skip bash "$setup_script" >/dev/null
test "$(sha256sum "$XDG_CONFIG_HOME/opencode/opencode.jsonc")" = "$open_code_after_retry"
test "$(sha256sum "$HOME/.omo/omo.jsonc")" = "$omo_after_retry"
assert_no_config_temporaries

printf '%s\n' '{ "malformed": [ }' >"$XDG_CONFIG_HOME/opencode/opencode.jsonc"
malformed_before="$(sha256sum "$XDG_CONFIG_HOME/opencode/opencode.jsonc")"
omo_before_failure="$(sha256sum "$HOME/.omo/omo.jsonc")"
if bash "$setup_script" >"$work_dir/malformed.stdout" 2>"$work_dir/malformed.stderr"; then
  echo "workspace setup unexpectedly accepted malformed OpenCode configuration" >&2
  exit 1
fi
test "$(sha256sum "$XDG_CONFIG_HOME/opencode/opencode.jsonc")" = "$malformed_before"
test "$(sha256sum "$HOME/.omo/omo.jsonc")" = "$omo_before_failure"
test "$(sha256sum "$GIT_CONFIG_GLOBAL")" = "$git_config_before"
assert_no_opencode_runtime

echo "workspace-user-setup-smoke-ok"
