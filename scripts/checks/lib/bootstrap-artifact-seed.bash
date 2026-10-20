#!/usr/bin/env bash
# Explicit test-tooling reuse of the optional VM package's digest artifact cache.
examples_artifacts_prepare() {
  local repository kind cached
  repository="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
  source "$repository/scripts/lib/bootstrap-ubuntu-pins.bash"
  source "$repository/packages/host/plugins/vm/scripts/artifact-cache.bash"
  EXAMPLES_ARTIFACTS_DIRECTORY="$BOOTSTRAP_WORK_ROOT/bootstrap-artifacts"
  mkdir -m 0700 -- "$EXAMPLES_ARTIFACTS_DIRECTORY"
  for kind in node pnpm just sysbox; do
    dim_bootstrap_artifact "$kind" amd64 || return
    cached="$(dim_artifact_cache "$dim_artifact_url" "$dim_artifact_sha256")" || return
    cp -- "$cached" "$EXAMPLES_ARTIFACTS_DIRECTORY/$dim_artifact_sha256" || return
    chmod 0600 -- "$EXAMPLES_ARTIFACTS_DIRECTORY/$dim_artifact_sha256" || return
    printf '%s  %s\n' "$dim_artifact_sha256" "$EXAMPLES_ARTIFACTS_DIRECTORY/$dim_artifact_sha256" | sha256sum --check --status || return
  done
}

examples_artifacts_seed_guest() {
  [[ -n "${EXAMPLES_ARTIFACTS_DIRECTORY:-}" && -d "$EXAMPLES_ARTIFACTS_DIRECTORY" ]] || {
    echo 'prepare pinned bootstrap artifacts before seeding a guest' >&2; return 2;
  }
  timeout 300s "${BOOTSTRAP_SCP[@]}" -r "$EXAMPLES_ARTIFACTS_DIRECTORY" dim@127.0.0.1:/home/dim/dim/
}
