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

development_entry="$(jq -c '.repositories.development // empty' "$DIM_PROJECT_MANIFEST")"
test -n "$development_entry" || {
  echo "required Project repository is not registered: development" >&2
  exit 1
}
test "$(printf '%s' "$development_entry" | jq -r '.phase')" = ready || {
  echo "Project repository is not ready: development" >&2
  exit 1
}
if [ ! -e "$integrated_root/.git" ]; then
  development_url="$(printf '%s' "$development_entry" | jq -r '.workspaceUrl')"
  staging="$integrated_root/.dim-development-clone"
  test ! -e "$staging"
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git -c core.hooksPath=/dev/null clone --branch main --single-branch "$development_url" "$staging"
  cp -a "$staging/." "$integrated_root/"
  rm -rf "$staging"
fi

repository core main "$integrated_root/core"
repository core-development main "$integrated_root/core-development"
repository plugin-dns-cloudflare main "$integrated_root/plugin-dns-cloudflare"
repository plugin-dns-cloudflare-development main "$integrated_root/plugin-dns-cloudflare-development"
repository plugin-external-urls main "$integrated_root/plugin-external-urls"
repository plugin-external-urls-development main "$integrated_root/plugin-external-urls-development"
repository verification main "$integrated_root/verification"
repository examples main "$integrated_root/examples"
repository specification main "$integrated_root/specification"
