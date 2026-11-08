#!/usr/bin/env bash
# Reviewed host-side downloads only. Cache lifetime is independent of workspaces.
# After URL and SHA-256, accept only bounded literal HTTP header values.
dim_artifact_cache() (
  set -euo pipefail
  local url="${1:?artifact URL required}" digest="${2:?SHA-256 required}"
  shift 2
  local LC_ALL=C
  local header name total_header_bytes=0
  local -a request_headers=()
  local header_name_pattern="^[!#\$%&'*+.^_\`|~0-9A-Za-z-]+$"
  (( $# <= 8 )) || { echo 'too many artifact headers' >&2; exit 2; }
  for header in "$@"; do
    name="${header%%:*}"
    total_header_bytes=$((total_header_bytes + ${#header}))
    [[ "$header" == *': '* && "$header" != @* && "$header" != -* && "$name" =~ $header_name_pattern && ! "$header" =~ [^[:print:]] && ${#header} -le 1024 && $total_header_bytes -le 4096 ]] || {
      echo 'invalid artifact header' >&2; exit 2;
    }
    request_headers+=(--header "$header")
  done
  local cache="${DIM_ARTIFACT_CACHE:-${XDG_CACHE_HOME:-${HOME:?}/.cache}/dim/artifacts}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ && "$cache" == /* && "$url" =~ ^https?:// && "$url" != *$'\n'* ]] || {
    printf 'artifact cache requires an absolute directory, HTTP(S) URL and lowercase SHA-256\n' >&2; exit 2;
  }
  umask 077
  mkdir -p -- "$cache"
  local target="$cache/$digest" partial="$cache/$digest.partial"
  exec {artifact_lock}>"$cache/$digest.lock"
  flock -x -w 1800 "$artifact_lock"
  [[ ! -L "$target" && ! -L "$partial" ]] || { printf 'artifact cache refuses symlink entries\n' >&2; exit 1; }
  if [[ -f "$target" ]] && printf '%s  %s\n' "$digest" "$target" | sha256sum --check --status; then
    printf '[artifact] cache hit %s\n' "$digest" >&2
    printf '%s\n' "$target"; exit 0
  fi
  if [[ -e "$target" ]]; then rm -- "$target"; fi
  if [[ -f "$partial" ]] && printf '%s  %s\n' "$digest" "$partial" | sha256sum --check --status; then
    chmod 0600 "$partial"
    sync -f "$partial"
    mv -- "$partial" "$target"
    sync -f "$cache"
    printf '%s\n' "$target"; exit 0
  fi
  # A server that does not support ranges must be retried from zero.
  printf '[artifact] downloading %s\n' "$digest" >&2
  local status=0 http_status
  http_status="$(curl --silent --show-error --fail --location --proto '=http,https' --proto-redir '=https' --tlsv1.2 --connect-timeout 30 --max-time 1800 \
    --speed-limit 1024 --speed-time 30 --retry 3 --retry-delay 2 \
    --continue-at - "${request_headers[@]}" --write-out '%{http_code}' --output "$partial" "$url" 2>/dev/null)" || status=$?
  if ((status == 33)); then
    rm -f -- "$partial"
    status=0
    http_status="$(curl --silent --show-error --fail --location --proto '=http,https' --proto-redir '=https' --tlsv1.2 --connect-timeout 30 --max-time 1800 \
      --speed-limit 1024 --speed-time 30 --retry 3 --retry-delay 2 \
      "${request_headers[@]}" --write-out '%{http_code}' --output "$partial" "$url" 2>/dev/null)" || status=$?
  fi
  if ((status != 0)); then
    [[ "$http_status" =~ ^[0-9]{3}$ ]] || http_status=000
    printf '[artifact] sha256=%s curl-exit=%s http-status=%s\n' "$digest" "$status" "$http_status" >&2
    exit "$status"
  fi
  if ! printf '%s  %s\n' "$digest" "$partial" | sha256sum --check --status; then
    rm -f -- "$partial"
    printf 'artifact SHA-256 mismatch: %s\n' "$digest" >&2; exit 1
  fi
  chmod 0600 "$partial"
  sync -f "$partial"
  mv -- "$partial" "$target"
  sync -f "$cache"
  printf '%s\n' "$target"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then dim_artifact_cache "$@"; fi
