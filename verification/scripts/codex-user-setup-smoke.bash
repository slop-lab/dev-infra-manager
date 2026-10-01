#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
setup_script="$repo_root/scripts/workspace-user-setup.bash"
work_dir="$(mktemp -d /tmp/dim-codex-user-setup.XXXXXX)"
system_path="$PATH"
trap 'rm -rf -- "$work_dir"' EXIT

unsafe_home="$work_dir/unsafe-home"
outside="$work_dir/outside"
mkdir -p "$unsafe_home" "$outside" "$work_dir/fake-bin"
ln -s "$outside" "$unsafe_home/.local"
cat >"$work_dir/fake-bin/npm" <<'EOF'
#!/usr/bin/env bash
: >"$NPM_INVOCATION_MARKER"
exit 97
EOF
chmod 0700 "$work_dir/fake-bin/npm"
if env HOME="$unsafe_home" PATH="$work_dir/fake-bin:$system_path" \
  NPM_INVOCATION_MARKER="$work_dir/npm-invoked" bash "$setup_script" codex \
  >"$work_dir/unsafe.stdout" 2>"$work_dir/unsafe.stderr"; then
  printf 'Codex setup unexpectedly accepted an escaping installation prefix\n' >&2
  exit 1
fi
test ! -e "$work_dir/npm-invoked"

export HOME="$work_dir/home"
export PATH="$HOME/.local/bin:$system_path"
mkdir -p "$HOME"
test ! -e "$HOME/.codex"

bash "$setup_script" codex >"$work_dir/setup-one.log"
test ! -e "$HOME/.codex"
test "$($HOME/.local/bin/codex --version)" = "codex-cli 0.156.1"
"$HOME/.local/bin/codex" --help >"$work_dir/help.stdout"
"$HOME/.local/bin/codex" exec --help >"$work_dir/exec-help.stdout"
"$HOME/.local/bin/codex" app-server --help >"$work_dir/app-server-help.stdout"
test -s "$work_dir/help.stdout"
test -s "$work_dir/exec-help.stdout"
test -s "$work_dir/app-server-help.stdout"

tool_launcher="$HOME/.local/libexec/dim-project-tool-launch"
tool_manifest="$HOME/.local/state/dim-project-tool/manifest.json"
tool_executable="$HOME/.local/bin/codex"
node - "$tool_manifest" "$tool_executable" <<'NODE'
const fs = require("node:fs")
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (manifest.contractVersion !== 1) throw new Error("unexpected contract version")
if (manifest.tool !== "codex" || manifest.version !== "0.156.1") throw new Error("unexpected tool identity")
if (manifest.launchers?.agent?.executable !== process.argv[3]) throw new Error("unexpected agent executable")
NODE
test "$("$tool_launcher" 1 agent codex 0.156.1 "$tool_executable" --version)" = "codex-cli 0.156.1"

mkdir -p "$HOME/.codex"
printf '%s\n' 'auth-sentinel' >"$HOME/.codex/auth.json"
printf '%s\n' 'config-sentinel' >"$HOME/.codex/config.toml"
auth_before="$(sha256sum "$HOME/.codex/auth.json")"
config_before="$(sha256sum "$HOME/.codex/config.toml")"
bash "$setup_script" codex >"$work_dir/setup-two.log"
test "$(sha256sum "$HOME/.codex/auth.json")" = "$auth_before"
test "$(sha256sum "$HOME/.codex/config.toml")" = "$config_before"

manifest_backup="$work_dir/manifest.json"
cp --preserve=mode "$tool_manifest" "$manifest_backup"
node - "$tool_manifest" <<'NODE'
const fs = require("node:fs")
const manifestPath = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
manifest.version = "0.156.0"
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
NODE
if "$tool_launcher" 1 agent codex 0.156.1 "$tool_executable" --version \
  >"$work_dir/incompatible.stdout" 2>"$work_dir/incompatible.stderr"; then
  printf 'Codex launcher unexpectedly accepted incompatible state\n' >&2
  exit 1
fi
grep -Fq 'installed tool manifest is missing or incompatible' "$work_dir/incompatible.stderr"
cp --preserve=mode "$manifest_backup" "$tool_manifest"

executable_backup="$work_dir/codex"
mv "$tool_executable" "$executable_backup"
cat >"$tool_executable" <<'EOF'
#!/usr/bin/env bash
printf '<%s>\n' "$@"
EOF
chmod 0700 "$tool_executable"
mapfile -t forwarded < <("$tool_launcher" 1 agent codex 0.156.1 "$tool_executable" \
  'space value' --flag=-leading '')
test "${forwarded[0]}" = '<space value>'
test "${forwarded[1]}" = '<--flag=-leading>'
test "${forwarded[2]}" = '<>'

rm "$tool_executable"
cat >"$work_dir/outside-codex" <<'EOF'
#!/usr/bin/env bash
printf 'outside executable ran\n'
EOF
chmod 0700 "$work_dir/outside-codex"
ln -s "$work_dir/outside-codex" "$tool_executable"
if "$tool_launcher" 1 agent codex 0.156.1 "$tool_executable" --version \
  >"$work_dir/outside.stdout" 2>"$work_dir/outside.stderr"; then
  printf 'Codex launcher unexpectedly accepted an executable outside HOME\n' >&2
  exit 1
fi
grep -Fq 'installed tool manifest is missing or incompatible' "$work_dir/outside.stderr"

echo codex-user-setup-smoke-ok
