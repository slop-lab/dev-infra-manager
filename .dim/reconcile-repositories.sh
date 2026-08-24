#!/usr/bin/env sh
set -eu

: "${DIM_PROJECT_MANIFEST:?DIM_PROJECT_MANIFEST is required}"
test -r "$DIM_PROJECT_MANIFEST"
integrated_root="${DIM_INTEGRATED_ROOT:-/workspace}"
case "$integrated_root" in
  /*) ;;
  *) echo "DIM_INTEGRATED_ROOT must be absolute" >&2; exit 2 ;;
esac

repository() {
  alias="$1"
  ref="$2"
  path="$3"
  entry="$(jq -c --arg alias "$alias" '.repositories[$alias] // empty' "$DIM_PROJECT_MANIFEST")"
  test -n "$entry" || {
    echo "required Project repository is not registered: $alias" >&2
    exit 1
  }
  test "$(printf '%s' "$entry" | jq -r '.phase')" = ready || {
    echo "Project repository is not ready: $alias" >&2
    exit 1
  }
  url="$(printf '%s' "$entry" | jq -r '.workspaceUrl')"
  test -n "$url"

  # Existing checkouts are agent-controlled. The reviewed outer lifecycle must
  # not invoke Git against their local config, hooks, or filters. Agents update
  # and switch their own checkouts from inside the private development runtime.
  test -e "$path" && return
  mkdir -p "$(dirname "$path")"
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git -c core.hooksPath=/dev/null clone --branch "$ref" --single-branch "$url" "$path"
}

repository development main "$integrated_root/workbench"
repository core main "$integrated_root/workbench/core"
repository core-development main "$integrated_root/workbench/core-development"
repository plugin-dns-cloudflare main "$integrated_root/workbench/plugin-dns-cloudflare"
repository plugin-dns-cloudflare-development main "$integrated_root/workbench/plugin-dns-cloudflare-development"
repository plugin-external-urls main "$integrated_root/workbench/plugin-external-urls"
repository plugin-external-urls-development main "$integrated_root/workbench/plugin-external-urls-development"
repository verification main "$integrated_root/workbench/verification"
repository examples main "$integrated_root/workbench/examples"
repository specification main "$integrated_root/workbench/specification"
