#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d /tmp/dim-plugin-install.XXXXXX)"
export XDG_RUNTIME_DIR="$root/runtime"
mkdir -m 0700 "$XDG_RUNTIME_DIR"

cleanup() {
  body_status="$?"
  trap - EXIT
  set +e
  cleanup_failed=false
  retain_root=false
  runtime_root="${XDG_RUNTIME_DIR:-/tmp/dim-$(id -u)}/dim"
  if [[ "$body_status" -ne 0 ]]; then
    if [[ -d "$runtime_root" ]]; then
      find "$runtime_root" -name controller.log -type f -exec sh -c '
        for log do echo "controller log: $log" >&2; tail -n 120 "$log" >&2; done
      ' sh {} + || true
    fi
  fi
  while IFS= read -r pid_file; do
    pid=""
    pid="$(cat "$pid_file" 2>/dev/null)" || continue
    case "$pid" in
      ''|*[!0-9]*|0|1) cleanup_failed=true ;;
      *)
        if ! kill -0 "$pid" >/dev/null 2>&1; then
          continue
        fi
        command_args=()
        if ! readarray -d '' -t command_args <"/proc/$pid/cmdline"; then
          if kill -0 "$pid" >/dev/null 2>&1; then
            echo "temporary DIM controller argv could not be read: $pid" >&2
            cleanup_failed=true
            retain_root=true
          fi
          continue
        fi
        controller_runtime_directory="${pid_file%/controller.pid}"
        expected_args=(
          "$(node -p 'process.execPath')"
          "$(realpath core/packages/cli/dist/cli.js)"
          controller serve
          --socket "$controller_runtime_directory/workspace/controller.sock"
          --agent-socket "$controller_runtime_directory/agent/controller.sock"
          --admin-socket "$controller_runtime_directory/admin/controller.sock"
          --pid-file "$pid_file"
        )
        argv_matches=true
        if [[ "${#command_args[@]}" -ne "${#expected_args[@]}" ]]; then
          argv_matches=false
        else
          for ((index = 0; index < ${#expected_args[@]}; index += 1)); do
            if [[ "${command_args[index]}" != "${expected_args[index]}" ]]; then
              argv_matches=false
              break
            fi
          done
        fi
        if [[ "$argv_matches" == true ]]; then
          if ! kill -TERM "$pid" >/dev/null 2>&1; then
            kill -0 "$pid" >/dev/null 2>&1 || continue
            cleanup_failed=true
          fi
          for _ in $(seq 1 50); do
            kill -0 "$pid" >/dev/null 2>&1 || break
            sleep 0.1
          done
          if kill -0 "$pid" >/dev/null 2>&1; then
            kill -KILL "$pid" >/dev/null 2>&1 || true
            for _ in $(seq 1 50); do
              kill -0 "$pid" >/dev/null 2>&1 || break
              sleep 0.1
            done
            if kill -0 "$pid" >/dev/null 2>&1; then
              echo "temporary DIM controller did not stop: $pid" >&2
              cleanup_failed=true
              retain_root=true
            fi
          fi
        else
          echo "temporary DIM controller identity did not match PID file: $pid_file" >&2
          cleanup_failed=true
        fi
        ;;
    esac
  done < <(find "$runtime_root" -name controller.pid -type f -print 2>/dev/null)
  if [[ "$retain_root" == false ]]; then
    find "$root" -depth -delete 2>/dev/null || true
  fi
  if [[ "$body_status" -eq 0 && "$cleanup_failed" == true ]]; then
    exit 1
  fi
  exit "$body_status"
}
trap cleanup EXIT

plugin_source="$root/plugin-source"
data_home="$root/data"
plugin_home="$data_home/runtime/current"
config_path="$root/config/dim/config.json"
installer_prefix="$root/installer"
package_bundle="$root/packages"
mkdir -p "$plugin_source"
bash verification/scripts/pack-local-packages.bash "$package_bundle" >/dev/null
core_version="$(jq -er '.packages[] | select(.name == "@slop-lab/dim-core") | .version' "$package_bundle/packages.json")"

printf '%s\n' \
  '{' \
  '  "name": "@example/dim-plugin-smoke",' \
  '  "version": "1.0.0",' \
  '  "type": "module",' \
  '  "exports": "./index.js",' \
  '  "peerDependencies": {' \
  "    \"@slop-lab/dim-core\": \"$core_version\"" \
  '  }' \
  '}' \
  > "$plugin_source/package.json"

printf '%s\n' \
  'export default {' \
  '  name: "@example/dim-plugin-smoke",' \
  '  apiVersion: 4,' \
  '  register() {}' \
  '};' \
  > "$plugin_source/index.js"

plugin_tarball="$(pnpm --dir "$plugin_source" pack --pack-destination "$root" --json | jq -r '.filename | split("/")[-1]')"
installer_tarball="$(pnpm --dir core/packages/installer/dist pack --pack-destination "$root" --json | jq -r '.filename | split("/")[-1]')"
npm install --prefix "$installer_prefix" "$root/$installer_tarball" >/dev/null

DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  install-cli --local-packages "$package_bundle" --no-local-bin >/dev/null

DIM_DATA_HOME="$data_home" DIM_CONFIG_PATH="$config_path" "$installer_prefix/node_modules/.bin/dim" \
  install-plugin \
  "$root/$plugin_tarball" \
  >/dev/null

jq '.workspaceBackend = "sysbox"' "$config_path" > "$root/config.json"
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
printf '%s\n' 'export default { name: "incompatible", apiVersion: 4, register() {} };' > "$incompatible_source/index.js"
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
