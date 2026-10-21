#!/usr/bin/env bash
set -euo pipefail
# bun-pty in the pinned OpenCode binary embeds a glibc library, even on musl.
# Keep this optional dependency and its process environment with the tools plugin.
if command -v apk >/dev/null 2>&1 && apk info --exists musl >/dev/null 2>&1; then
  if ! apk info --exists gcompat >/dev/null 2>&1; then
    if [[ "$(id -u)" = 0 ]]; then
      apk add --no-cache gcompat >&2
    else
      sudo -n apk add --no-cache gcompat >&2
    fi
  fi
  [[ -r /lib/libgcompat.so.0 ]] || { echo 'OpenCode requires the Alpine gcompat library for terminal support' >&2; exit 1; }
  node - <<'NODE'
const library = '/lib/libgcompat.so.0';
const entries = (process.env.LD_PRELOAD || '').split(/[\s:]+/).filter(Boolean);
if (!entries.includes(library)) entries.push(library);
console.log(JSON.stringify({LD_PRELOAD: entries.join(':')}));
NODE
else
  printf '{}\n'
fi
