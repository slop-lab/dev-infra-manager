#!/usr/bin/env bash
# Copy untrusted cache bytes into the installer's private staging area, then verify.
# Explicit cache selection is offline/fail-closed; it never silently downloads.
# Optional trailing arguments are literal HTTP header values, never curl flags.
dim_bootstrap_download() {
  local url="$1" digest="$2" output="$3" cached output_parent http_status status=0
  shift 3
  local LC_ALL=C
  local kind="${dim_artifact_kind:-artifact}" header name total_header_bytes=0
  local -a request_headers=()
  local header_name_pattern="^[!#\$%&'*+.^_\`|~0-9A-Za-z-]+$"
  case "$kind" in artifact|node|pnpm|just|sysbox) ;; *) echo 'invalid artifact label' >&2; return 2 ;; esac
  (( $# <= 8 )) || { echo 'too many artifact headers' >&2; return 2; }
  for header in "$@"; do
    name="${header%%:*}"
    total_header_bytes=$((total_header_bytes + ${#header}))
    [[ "$header" == *': '* && "$header" != @* && "$header" != -* && "$name" =~ $header_name_pattern && ! "$header" =~ [^[:print:]] && ${#header} -le 1024 && $total_header_bytes -le 4096 ]] || {
      echo 'invalid artifact header' >&2; return 2;
    }
    request_headers+=(--header "$header")
  done
  output_parent="$(dirname -- "$output")"
  [[ "$digest" =~ ^[0-9a-f]{64}$ && ! -e "$output" && ! -L "$output" ]] || {
    echo 'bootstrap download requires SHA-256 and a new private output file' >&2; return 2;
  }
  [[ -d "$output_parent" && ! -L "$output_parent" && "$(/usr/bin/stat -c '%u:%a' -- "$output_parent")" == "$(/usr/bin/id -u):700" ]] || {
    echo 'bootstrap download output must have a private installer-owned parent' >&2; return 2;
  }
  if [[ -n "${DIM_BOOTSTRAP_DOWNLOAD_CACHE:-}" ]]; then
    [[ "$DIM_BOOTSTRAP_DOWNLOAD_CACHE" == /* && -d "$DIM_BOOTSTRAP_DOWNLOAD_CACHE" && ! -L "$DIM_BOOTSTRAP_DOWNLOAD_CACHE" ]] || {
      echo 'bootstrap artifact input must be an absolute directory, not a symlink' >&2; return 2;
    }
    cached="$DIM_BOOTSTRAP_DOWNLOAD_CACHE/$digest"
    [[ -f "$cached" && ! -L "$cached" ]] || { echo "missing bootstrap artifact $digest" >&2; return 1; }
    # The guest operator may own the input. Root trusts only the pinned digest,
    # never the shared inode, its filename, or a checksum checked before copying.
    /usr/bin/cp --no-dereference -- "$cached" "$output" || return
    [[ -f "$output" && ! -L "$output" ]] || { echo 'bootstrap artifact copy is not a regular file' >&2; return 1; }
  else
    http_status="$(/usr/bin/curl --fail --silent --show-error --location --proto '=https,file' --proto-redir '=https' "${request_headers[@]}" --write-out '%{http_code}' --output "$output" "$url" 2>/dev/null)" || status=$?
    if ((status != 0)); then
      [[ "$http_status" =~ ^[0-9]{3}$ ]] || http_status=000
      printf '[bootstrap] artifact=%s curl-exit=%s http-status=%s\n' "$kind" "$status" "$http_status" >&2
      return "$status"
    fi
  fi
  if ! printf '%s  %s\n' "$digest" "$output" | /usr/bin/sha256sum --check --status; then
    /usr/bin/rm -f -- "$output"
    echo "bootstrap artifact SHA-256 mismatch: $digest" >&2; return 1
  fi
  /usr/bin/chmod 0600 -- "$output"
}
