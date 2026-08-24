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
  path="$2"
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
  ref="$(printf '%s' "$entry" | jq -r '.ref')"
  commit="$(printf '%s' "$entry" | jq -r '.commit')"
  test -n "$url"
  test -n "$ref" -a "$ref" != null
  printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40,64}$'

  # Existing checkouts are agent-controlled. The reviewed outer lifecycle must
  # not invoke Git against their local config, hooks, or filters. Agents update
  # and switch their own checkouts from inside the private development runtime.
  test -e "$path" && return
  mkdir -p "$(dirname "$path")"
  case "$ref" in
    refs/heads/*)
      branch="${ref#refs/heads/}"
      GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        git -c core.hooksPath=/dev/null clone --branch "$branch" --single-branch "$url" "$path"
      ;;
    *)
      GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        git -c core.hooksPath=/dev/null clone --no-checkout "$url" "$path"
      GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        git -C "$path" -c core.hooksPath=/dev/null checkout --detach "$commit"
      ;;
  esac
  test "$(git -C "$path" rev-parse HEAD)" = "$commit"
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
  staging="$integrated_root/.dim-development-clone"
  test ! -e "$staging"
  repository development "$staging"
  cp -a "$staging/." "$integrated_root/"
  rm -rf "$staging"
fi

exclude="$integrated_root/.git/info/exclude"
for path in \
  node_modules/ .pnpm-store/ project/ \
  core/ core-development/ \
  plugin-dns-cloudflare/ plugin-dns-cloudflare-development/ \
  plugin-external-urls/ plugin-external-urls-development/ \
  verification/ examples/ specification/
do
  grep -Fxq "$path" "$exclude" || printf '%s\n' "$path" >>"$exclude"
done

repository core "$integrated_root/core"
repository core-development "$integrated_root/core-development"
repository plugin-dns-cloudflare "$integrated_root/plugin-dns-cloudflare"
repository plugin-dns-cloudflare-development "$integrated_root/plugin-dns-cloudflare-development"
repository plugin-external-urls "$integrated_root/plugin-external-urls"
repository plugin-external-urls-development "$integrated_root/plugin-external-urls-development"
repository verification "$integrated_root/verification"
repository examples "$integrated_root/examples"
repository specification "$integrated_root/specification"
