#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d /tmp/dim-plugin-install.XXXXXX)"

cleanup() {
  find "$root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

plugin_source="$root/plugin-source"
plugin_home="$root/plugin-home"
config_path="$root/config/slop-lab/dim.json"
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
  '  apiVersion: 1,' \
  '  register(host) {' \
  '    host.registerRepositoryProvider({' \
  '      kind: "smoke-mirror",' \
  '      async register() { throw new Error("not used by smoke"); }' \
  '    });' \
  '  }' \
  '};' \
  > "$plugin_source/index.js"

plugin_tarball="$(npm pack "$plugin_source" --pack-destination "$root" --json | jq -r '.[0].filename')"
installer_tarball="$(npm pack packages/install/dist --pack-destination "$root" --json | jq -r '.[0].filename')"
npm install --prefix "$installer_prefix" "$root/$installer_tarball" >/dev/null

DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/install-dim" \
  plugin \
  --plugin-home "$plugin_home" \
  "$root/$plugin_tarball" \
  >/dev/null

test "$(jq -r .pluginHome "$config_path")" = "$plugin_home"
result="$(DIM_CONFIG_PATH="$config_path" node packages/dim-cli/dist/cli.js plugin list)"
test "$(printf '%s' "$result" | jq -r '.plugins[0]')" = "@example/dim-plugin-smoke"
test "$(printf '%s' "$result" | jq -r '.repositoryProviders[0]')" = "smoke-mirror"

echo "plugin-install-smoke-ok"
