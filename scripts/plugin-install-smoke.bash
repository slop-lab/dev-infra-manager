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
  '    "@slop-lab/dim-core": "0.8.0"' \
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
installer_tarball="$(pnpm --dir core/packages/installer/dist pack --pack-destination "$root" --json | jq -r '.filename | split("/")[-1]')"
npm install --prefix "$installer_prefix" "$root/$installer_tarball" >/dev/null
bash verification/scripts/pack-local-packages.bash "$package_bundle" >/dev/null

DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  install-cli --local-packages "$package_bundle" --no-local-bin >/dev/null

DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  install-plugin \
  "$root/$plugin_tarball" \
  >/dev/null

jq '.workspaceBackend = "runc"' "$config_path" > "$root/config.json"
mv "$root/config.json" "$config_path"
result="$(DIM_STATE_ROOT="$root/state" DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" node core/packages/cli/dist/cli.js plugin list --json)"
test "$(printf '%s' "$result" | jq -r '.plugins[0]')" = "@example/dim-plugin-smoke"

# The installer owns a durable copy; replacing the CLI must not depend on the
# caller's temporary tarball still existing.
rm "$root/$plugin_tarball"
DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  install-cli --local-packages "$package_bundle" --no-local-bin >/dev/null
result="$(DIM_STATE_ROOT="$root/state" DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" node core/packages/cli/dist/cli.js plugin list --json)"
test "$(printf '%s' "$result" | jq -r '.plugins[0]')" = "@example/dim-plugin-smoke"

incompatible_source="$root/incompatible-source"
mkdir -p "$incompatible_source"
printf '%s\n' \
  '{' \
  '  "name": "@example/dim-plugin-incompatible",' \
  '  "version": "1.0.0",' \
  '  "type": "module",' \
  '  "exports": "./index.js",' \
  '  "peerDependencies": { "@slop-lab/dim-core": "99.0.0" }' \
  '}' > "$incompatible_source/package.json"
printf '%s\n' 'export default { name: "incompatible", apiVersion: 3, register() {} };' > "$incompatible_source/index.js"
incompatible_tarball="$(pnpm --dir "$incompatible_source" pack --pack-destination "$root" --json | jq -r '.filename | split("/")[-1]')"
package_before="$(sha256sum "$plugin_home/package.json")"
manifest_before="$(sha256sum "$plugin_home/plugins.json")"
if DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  install-plugin "$root/$incompatible_tarball" >/dev/null 2>&1; then
  echo "incompatible plugin unexpectedly installed" >&2
  exit 1
fi
test "$(sha256sum "$plugin_home/package.json")" = "$package_before"
test "$(sha256sum "$plugin_home/plugins.json")" = "$manifest_before"

DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  disable-plugin '@example/dim-plugin-smoke' >/dev/null
test "$(jq '.plugins | length' "$plugin_home/plugins.json")" = 0

DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  enable-plugin '@example/dim-plugin-smoke' >/dev/null
test "$(jq -r '.plugins[0]' "$plugin_home/plugins.json")" = "@example/dim-plugin-smoke"

DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  remove-plugin '@example/dim-plugin-smoke' >/dev/null
test "$(jq '.plugins | length' "$plugin_home/plugins.json")" = 0
test "$(jq '.dependencies | has("@example/dim-plugin-smoke")' "$plugin_home/package.json")" = false
test -z "$(find "$data_home/runtime/sources" -type f -print -quit)"

echo "plugin-install-smoke-ok"
