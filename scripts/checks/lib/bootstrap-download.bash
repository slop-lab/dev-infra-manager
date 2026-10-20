#!/usr/bin/env bash
# Copy untrusted cache bytes into the installer's private staging area, then verify.
# Explicit cache selection is offline/fail-closed; it never silently downloads.
dim_bootstrap_download() {
  local url="$1" digest="$2" output="$3" cached output_parent
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
    /usr/bin/curl --fail --silent --show-error --location --proto '=https,file' --proto-redir '=https' --output "$output" "$url" || return
  fi
  if ! printf '%s  %s\n' "$digest" "$output" | /usr/bin/sha256sum --check --status; then
    /usr/bin/rm -f -- "$output"
    echo "bootstrap artifact SHA-256 mismatch: $digest" >&2; return 1
  fi
  /usr/bin/chmod 0600 -- "$output"
}
