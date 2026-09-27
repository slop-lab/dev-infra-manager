#!/usr/bin/env bash

# Runs a disposable Verdaccio registry seeded from locally built tarballs. The
# registry is reachable only from the environment running this helper. Current
# host consumers install DIM before starting nested containers, while the mise
# smoke starts this helper inside its disposable container.
#
# Requires `node`, `npm`, `curl`, and `setsid` on PATH, plus network access for
# proxied public dependencies.

DIM_LOCAL_REGISTRY_PID=""
DIM_LOCAL_REGISTRY_PORT=""
DIM_LOCAL_REGISTRY_URL=""
DIM_LOCAL_REGISTRY_USERNAME=""
DIM_LOCAL_REGISTRY_PASSWORD=""
DIM_LOCAL_REGISTRY_WORK_DIR=""
DIM_LOCAL_REGISTRY_ENV_CAPTURED=""
DIM_LOCAL_REGISTRY_PREVIOUS_USERCONFIG_SET=""
DIM_LOCAL_REGISTRY_PREVIOUS_USERCONFIG=""
DIM_LOCAL_REGISTRY_PREVIOUS_REGISTRY_SET=""
DIM_LOCAL_REGISTRY_PREVIOUS_REGISTRY=""

dim_local_registry_write_config() {
  local work_dir="$1"
  local max_users="$2"
  local storage="$work_dir/registry-storage"
  local config="$work_dir/verdaccio.yaml"

  (
    umask 077
    cat >"$config" <<YAML
storage: $storage
auth:
  htpasswd:
    file: $work_dir/htpasswd
    algorithm: bcrypt
    max_users: $max_users
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@slop-lab/*':
    access: \$all
    publish: \$authenticated
    unpublish: \$authenticated
  '**':
    access: \$all
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
listen: 127.0.0.1:$DIM_LOCAL_REGISTRY_PORT
YAML
  )
  chmod 600 "$config"
}

dim_local_registry_shutdown_process() {
  if [[ -n "$DIM_LOCAL_REGISTRY_PID" ]]; then
    kill -- "-$DIM_LOCAL_REGISTRY_PID" >/dev/null 2>&1 || true
    wait "$DIM_LOCAL_REGISTRY_PID" >/dev/null 2>&1 || true
    DIM_LOCAL_REGISTRY_PID=""
  fi
}

dim_local_registry_launch() {
  local work_dir="$1"
  local config="$work_dir/verdaccio.yaml"
  local log="$work_dir/verdaccio.log"
  local script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  local verdaccio_bin="$script_dir/../../node_modules/verdaccio/bin/verdaccio"

  (
    umask 077
    exec setsid node "$verdaccio_bin" --config "$config" \
      --listen "127.0.0.1:$DIM_LOCAL_REGISTRY_PORT"
  ) >"$log" 2>&1 &
  DIM_LOCAL_REGISTRY_PID=$!

  local attempt
  for attempt in $(seq 1 30); do
    if curl -4 --silent --fail "$DIM_LOCAL_REGISTRY_URL/" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$DIM_LOCAL_REGISTRY_PID" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  echo "local npm registry failed to start" >&2
  cat "$log" >&2
  dim_local_registry_shutdown_process
  return 1
}

# dim_start_local_npm_registry WORK_DIR
# Starts Verdaccio on a randomly selected IPv4 loopback port, creates one
# random publisher account, closes signup, and configures npm in this shell.
dim_start_local_npm_registry() {
  local work_dir="$1"
  local response token

  if [[ -n "$DIM_LOCAL_REGISTRY_PID" ]]; then
    echo "local npm registry is already running" >&2
    return 1
  fi

  DIM_LOCAL_REGISTRY_WORK_DIR="$work_dir"
  mkdir -p "$work_dir/registry-storage"
  chmod 700 "$work_dir/registry-storage"
  DIM_LOCAL_REGISTRY_PORT="$(node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) process.exit(1);
      process.stdout.write(String(address.port));
      server.close();
    });
  ')"
  DIM_LOCAL_REGISTRY_URL="http://127.0.0.1:$DIM_LOCAL_REGISTRY_PORT"
  DIM_LOCAL_REGISTRY_USERNAME="dim-publisher-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
  DIM_LOCAL_REGISTRY_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"

  dim_local_registry_write_config "$work_dir" 1
  if ! dim_local_registry_launch "$work_dir"; then
    dim_stop_local_npm_registry
    return 1
  fi

  if ! response="$(node -e '
    const [username, password] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      _id: `org.couchdb.user:${username}`,
      name: username,
      password,
      type: "user",
      roles: []
    }));
  ' "$DIM_LOCAL_REGISTRY_USERNAME" "$DIM_LOCAL_REGISTRY_PASSWORD" | \
    curl --silent --fail-with-body --request PUT \
      "$DIM_LOCAL_REGISTRY_URL/-/user/org.couchdb.user:$DIM_LOCAL_REGISTRY_USERNAME" \
      --header "Content-Type: application/json" --data-binary @-)"; then
    echo "failed to create local registry publisher: $response" >&2
    dim_stop_local_npm_registry
    return 1
  fi
  if ! token="$(printf '%s' "$response" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const token = JSON.parse(input).token;
      if (typeof token !== "string" || token.length === 0) process.exit(1);
      process.stdout.write(token);
    });
  ')"; then
    echo "local registry publisher response did not contain a token" >&2
    dim_stop_local_npm_registry
    return 1
  fi
  chmod 600 "$work_dir/htpasswd"

  dim_local_registry_shutdown_process
  dim_local_registry_write_config "$work_dir" -1
  if ! dim_local_registry_launch "$work_dir"; then
    dim_stop_local_npm_registry
    return 1
  fi

  (
    umask 077
    printf 'registry=%s\n//127.0.0.1:%s/:_authToken=%s\n' \
      "$DIM_LOCAL_REGISTRY_URL" "$DIM_LOCAL_REGISTRY_PORT" "$token" >"$work_dir/npmrc"
  )
  chmod 600 "$work_dir/npmrc" "$work_dir/verdaccio.log"

  DIM_LOCAL_REGISTRY_ENV_CAPTURED=1
  if [[ -v NPM_CONFIG_USERCONFIG ]]; then
    DIM_LOCAL_REGISTRY_PREVIOUS_USERCONFIG_SET=1
    DIM_LOCAL_REGISTRY_PREVIOUS_USERCONFIG="$NPM_CONFIG_USERCONFIG"
  fi
  if [[ -v npm_config_registry ]]; then
    DIM_LOCAL_REGISTRY_PREVIOUS_REGISTRY_SET=1
    DIM_LOCAL_REGISTRY_PREVIOUS_REGISTRY="$npm_config_registry"
  fi
  export NPM_CONFIG_USERCONFIG="$work_dir/npmrc"
  export npm_config_registry="$DIM_LOCAL_REGISTRY_URL"
}

# dim_publish_to_local_registry TARBALL...
dim_publish_to_local_registry() {
  local tarball
  for tarball in "$@"; do
    npm publish "$tarball" --registry "$DIM_LOCAL_REGISTRY_URL" --tag dim-local >/dev/null
  done
}

dim_stop_local_npm_registry() {
  dim_local_registry_shutdown_process

  if [[ -n "$DIM_LOCAL_REGISTRY_WORK_DIR" ]]; then
    rm -rf \
      "$DIM_LOCAL_REGISTRY_WORK_DIR/registry-storage" \
      "$DIM_LOCAL_REGISTRY_WORK_DIR/verdaccio.yaml" \
      "$DIM_LOCAL_REGISTRY_WORK_DIR/verdaccio.log" \
      "$DIM_LOCAL_REGISTRY_WORK_DIR/htpasswd" \
      "$DIM_LOCAL_REGISTRY_WORK_DIR/npmrc"
  fi

  if [[ -n "$DIM_LOCAL_REGISTRY_ENV_CAPTURED" ]]; then
    if [[ -n "$DIM_LOCAL_REGISTRY_PREVIOUS_USERCONFIG_SET" ]]; then
      export NPM_CONFIG_USERCONFIG="$DIM_LOCAL_REGISTRY_PREVIOUS_USERCONFIG"
    else
      unset NPM_CONFIG_USERCONFIG
    fi
    if [[ -n "$DIM_LOCAL_REGISTRY_PREVIOUS_REGISTRY_SET" ]]; then
      export npm_config_registry="$DIM_LOCAL_REGISTRY_PREVIOUS_REGISTRY"
    else
      unset npm_config_registry
    fi
  fi

  DIM_LOCAL_REGISTRY_PORT=""
  DIM_LOCAL_REGISTRY_URL=""
  DIM_LOCAL_REGISTRY_USERNAME=""
  DIM_LOCAL_REGISTRY_PASSWORD=""
  DIM_LOCAL_REGISTRY_WORK_DIR=""
  DIM_LOCAL_REGISTRY_ENV_CAPTURED=""
  DIM_LOCAL_REGISTRY_PREVIOUS_USERCONFIG_SET=""
  DIM_LOCAL_REGISTRY_PREVIOUS_USERCONFIG=""
  DIM_LOCAL_REGISTRY_PREVIOUS_REGISTRY_SET=""
  DIM_LOCAL_REGISTRY_PREVIOUS_REGISTRY=""
}
