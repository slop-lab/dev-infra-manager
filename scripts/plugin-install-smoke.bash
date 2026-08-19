#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d /tmp/dim-plugin-install.XXXXXX)"

cleanup() {
  if [[ -f "$root/state/controller/controller.pid" ]]; then
    kill "$(cat "$root/state/controller/controller.pid")" >/dev/null 2>&1 || true
  fi
  find "$root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

plugin_source="$root/plugin-source"
data_home="$root/data"
plugin_home="$data_home/runtime/current"
config_path="$root/config/dim/config.json"
installer_prefix="$root/installer"
package_bundle="$root/packages"
mkdir -p "$plugin_source"

printf '%s\n' \
  '{' \
  '  "name": "@example/dim-plugin-smoke",' \
  '  "version": "1.0.0",' \
  '  "type": "module",' \
  '  "exports": "./index.js",' \
  '  "peerDependencies": {' \
  '    "@slop-lab/dim-core": "0.7.0"' \
  '  }' \
  '}' \
  > "$plugin_source/package.json"

printf '%s\n' \
  'export default {' \
  '  name: "@example/dim-plugin-smoke",' \
  '  apiVersion: 3,' \
  '  register() {}' \
  '};' \
  > "$plugin_source/index.js"

plugin_tarball="$(pnpm --dir "$plugin_source" pack --pack-destination "$root" --json | jq -r '.filename | split("/")[-1]')"
installer_tarball="$(pnpm --dir packages/installer/dist pack --pack-destination "$root" --json | jq -r '.filename | split("/")[-1]')"
npm install --prefix "$installer_prefix" "$root/$installer_tarball" >/dev/null
bash scripts/pack-local-packages.bash "$package_bundle" >/dev/null

DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  install-cli --local-packages "$package_bundle" --no-local-bin >/dev/null

DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  install-plugin \
  "$root/$plugin_tarball" \
  >/dev/null

jq '.workspaceBackend = "runc"' "$config_path" > "$root/config.json"
mv "$root/config.json" "$config_path"
result="$(DIM_STATE_ROOT="$root/state" DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" node packages/cli/dist/cli.js plugin list --json)"
test "$(printf '%s' "$result" | jq -r '.plugins[0]')" = "@example/dim-plugin-smoke"

# Replacing the CLI rebuilds one dependency graph and retains enabled plugins.
DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  install-cli --local-packages "$package_bundle" --no-local-bin >/dev/null
result="$(DIM_STATE_ROOT="$root/state" DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" node packages/cli/dist/cli.js plugin list --json)"
test "$(printf '%s' "$result" | jq -r '.plugins[0]')" = "@example/dim-plugin-smoke"

echo "plugin-install-smoke-ok"
