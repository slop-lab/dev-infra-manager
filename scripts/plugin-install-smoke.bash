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
plugin_home="$root/plugin-home"
config_path="$root/config/dim/config.json"
installer_prefix="$root/installer"
mkdir -p "$plugin_source"

printf '%s\n' \
  '{' \
  '  "name": "@example/dim-plugin-smoke",' \
  '  "version": "1.0.0",' \
  '  "type": "module",' \
  '  "exports": "./index.js"' \
  '}' \
  > "$plugin_source/package.json"

printf '%s\n' \
  'export default {' \
  '  name: "@example/dim-plugin-smoke",' \
  '  apiVersion: 3,' \
  '  register() {}' \
  '};' \
  > "$plugin_source/index.js"

plugin_tarball="$(npm pack "$plugin_source" --pack-destination "$root" --json | jq -r '.[0].filename')"
installer_tarball="$(npm pack packages/installer/dist --pack-destination "$root" --json | jq -r '.[0].filename')"
npm install --prefix "$installer_prefix" "$root/$installer_tarball" >/dev/null

DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  install-plugin \
  --plugin-home "$plugin_home" \
  "$root/$plugin_tarball" \
  >/dev/null

test "$(jq -r .pluginHome "$config_path")" = "$plugin_home"
jq '.workspaceBackend = "runc"' "$config_path" > "$root/config.json"
mv "$root/config.json" "$config_path"
result="$(DIM_STATE_ROOT="$root/state" DIM_CONFIG_PATH="$config_path" node packages/cli/dist/cli.js plugin list --json)"
test "$(printf '%s' "$result" | jq -r '.plugins[0]')" = "@example/dim-plugin-smoke"

echo "plugin-install-smoke-ok"
