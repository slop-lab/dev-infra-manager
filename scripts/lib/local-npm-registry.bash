#!/usr/bin/env bash

# Runs a disposable verdaccio registry seeded from locally built tarballs, so
# smoke tests can exercise real `npm install`/`mise use -g npm:...` flows
# against unreleased package versions without touching the real npm
# registry. Two things learned the hard way while building this:
#
#   - verdaccio only binds IPv6 loopback unless `--listen 0.0.0.0:<port>` is
#     given explicitly; a bare port number leaves 127.0.0.1 refusing
#     connections.
#   - Some npm-driving tools (mise's npm backend, notably) don't reliably
#     pick up a registry written to a global .npmrc file. Exporting
#     npm_config_registry as an environment variable works everywhere; this
#     helper always does both.
#   - `npm config set --location=global` (or `=user`) needs write access to
#     a system or home-directory file that may not be writable (no root, or
#     a shared home). This helper instead points NPM_CONFIG_USERCONFIG at a
#     throwaway file under WORK_DIR, so it never touches real npm config and
#     never needs elevated permissions.
#
# Requires: docker is not needed here, but `node`, `npm`, and `curl` must be
# on PATH, and network access to fetch verdaccio itself from the real npm
# registry.

DIM_LOCAL_REGISTRY_PID=""
DIM_LOCAL_REGISTRY_URL="http://127.0.0.1:4873"

# dim_start_local_npm_registry WORK_DIR
# Starts verdaccio in the background, storing state under WORK_DIR, and
# points the current shell's npm configuration (both global .npmrc and
# npm_config_registry) at it. Call dim_stop_local_npm_registry on exit.
dim_start_local_npm_registry() {
  local work_dir="$1"
  local storage="$work_dir/registry-storage"
  local config="$work_dir/verdaccio.yaml"
  local log="$work_dir/verdaccio.log"

  mkdir -p "$storage"
  cat > "$config" <<YAML
storage: $storage
auth:
  htpasswd:
    file: $work_dir/htpasswd
    max_users: 1000
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@slop-lab/*':
    access: \$all
    publish: \$all
    unpublish: \$all
  '**':
    access: \$all
    publish: \$all
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
listen: 0.0.0.0:4873
YAML

  npx --yes verdaccio@6.8.0 --config "$config" --listen 0.0.0.0:4873 >"$log" 2>&1 &
  DIM_LOCAL_REGISTRY_PID=$!

  local attempt
  for attempt in $(seq 1 30); do
    curl -4 -sf "$DIM_LOCAL_REGISTRY_URL/" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -4 -sf "$DIM_LOCAL_REGISTRY_URL/" >/dev/null || {
    echo "local npm registry failed to start" >&2
    cat "$log" >&2
    return 1
  }

  local response token
  response="$(curl -s -X PUT "$DIM_LOCAL_REGISTRY_URL/-/user/org.couchdb.user:smoketest" \
    -H "Content-Type: application/json" \
    -d "{\"_id\":\"org.couchdb.user:smoketest\",\"name\":\"smoketest\",\"password\":\"smoketestpass\",\"type\":\"user\",\"roles\":[],\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"}")"
  token="$(echo "$response" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).token))')"
  if [[ -z "$token" || "$token" == "undefined" ]]; then
    echo "failed to register local registry user: $response" >&2
    return 1
  fi

  printf 'registry=%s\n//127.0.0.1:4873/:_authToken=%s\n' "$DIM_LOCAL_REGISTRY_URL" "$token" > "$work_dir/npmrc"
  export NPM_CONFIG_USERCONFIG="$work_dir/npmrc"
  export npm_config_registry="$DIM_LOCAL_REGISTRY_URL"
}

# dim_publish_to_local_registry TARBALL...
dim_publish_to_local_registry() {
  local tarball
  for tarball in "$@"; do
    npm publish "$tarball" --registry "$DIM_LOCAL_REGISTRY_URL" >/dev/null
  done
}

dim_stop_local_npm_registry() {
  if [[ -n "$DIM_LOCAL_REGISTRY_PID" ]]; then
    kill "$DIM_LOCAL_REGISTRY_PID" >/dev/null 2>&1 || true
    wait "$DIM_LOCAL_REGISTRY_PID" >/dev/null 2>&1 || true
    DIM_LOCAL_REGISTRY_PID=""
  fi
}
