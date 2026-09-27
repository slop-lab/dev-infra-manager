#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd -- "$script_dir/../.." && pwd)"
examples_root="${DIM_EXAMPLES_ROOT:-$workspace_root/examples}"
example="$examples_root/projects/two-repository"
root="$example/repos/root"
app="$example/repos/app"
manifest="$root/.dim/repos.yml"
compose="$root/.dim/docker-compose.yml"
dockerfile="$root/.dim/app-runtime/Dockerfile"
setup="$root/.dim/setup.sh"
entrypoint="$root/.dim/entrypoint.sh"
teardown="$root/.dim/teardown.sh"

test "$(jq -c '.repositories.root.protect' "$manifest")" = '["main"]'
test "$(jq -c '.repositories.app.protect // []' "$manifest")" = '[]'
test ! -e "$app/.dim"

compose_json="$(
  DIM_PROJECT_ROOT=/tmp/dim-two-repository-policy \
  DIM_GIT_USERNAME=policy DIM_GIT_TOKEN=policy \
    docker compose --file "$compose" config --format json
)"
jq -e '
  (.services | keys) == ["app"] and
  ((.services.app.privileged // false) == false) and
  .services.app.cap_drop == ["ALL"] and
  (.services.app.security_opt | any(. == "no-new-privileges:true")) and
  .services.app.working_dir == "/workspace" and
  (.services.app.volumes | length) == 2 and
  (.services.app.volumes | any(.target == "/workspace" and .type == "bind")) and
  (.services.app.volumes | any(.target == "/home/dim-agent" and .type == "volume")) and
  (.services.app.environment.DIM_GIT_USERNAME == "policy") and
  (.services.app.environment.DIM_GIT_TOKEN == "policy") and
  (.services.app.environment.GIT_CONFIG_KEY_0 == "credential.helper")
' <<<"$compose_json" >/dev/null

! grep -Eq '/var/run/docker\.sock|/run/dim|/dev/|privileged:[[:space:]]*true' "$compose"
grep -Eq '^FROM ubuntu:24\.04@sha256:[0-9a-f]{64}$' "$dockerfile"
grep -Fq 'ENTRYPOINT ["/usr/bin/tini", "--"]' "$dockerfile"
grep -Fq 'USER dim-agent' "$dockerfile"
! grep -Eq '\b(sudo|docker\.io|docker-ce|docker-cli)\b' "$dockerfile"

grep -Fq 'sh .dim/materialize-app.sh' "$setup"
grep -Eq 'up --detach --build app' "$setup"
grep -Fq -- '--user "$(id -u):$(id -g)" --workdir /workspace' "$entrypoint"
grep -Fq -- '--env HOME=/home/dim-agent app "$@"' "$entrypoint"
grep -Fq 'down --volumes' "$teardown"
! grep -Fq -- '--remove-orphans' "$teardown"
! grep -R -F ':latest' "$root/.dim"

echo two-repository-policy-smoke-ok
