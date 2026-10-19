#!/usr/bin/env bash
set -euo pipefail

remote=origin
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --remote) remote="${2:?--remote requires a value}"; shift 2 ;;
    *) echo "usage: detect-forge.bash [--remote REMOTE]" >&2; exit 2 ;;
  esac
done

[[ "$remote" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  echo 'pull-request: invalid remote name' >&2
  exit 2
}
url="$(git remote get-url "$remote" 2>/dev/null)" || {
  printf "pull-request: Git remote '%s' does not exist\n" "$remote" >&2
  exit 1
}

# Offline identification only. A scoped DIM repository URL is not a forge API,
# and an obsolete localhost service must never receive a discovery request.
shopt -s nocasematch
repository=""
if [[ "$url" =~ ^https://github\.com(:443)?/(.+)$ ]]; then
  repository="${BASH_REMATCH[2]}"
elif [[ "$url" =~ ^(git@)?github\.com:(.+)$ ]]; then
  repository="${BASH_REMATCH[2]}"
elif [[ "$url" =~ ^ssh://(git@)?(github\.com(:22)?|ssh\.github\.com(:443)?)/(.+)$ ]]; then
  repository="${BASH_REMATCH[5]}"
fi
repository="${repository%/}"
repository="${repository%.git}"
if [[ "$repository" =~ ^([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9_.-]+)$ \
  && "${BASH_REMATCH[2]}" != . && "${BASH_REMATCH[2]}" != .. ]]; then
  # Every interpolated field is restricted to the safe identifier characters
  # above. Return the canonical URL, never a credential-bearing raw Git URL.
  printf '{"provider":"github","remote":"%s","remoteUrl":"https://github.com/%s.git","forgeUrl":"https://github.com","repository":"%s"}\n' \
    "$remote" "$repository" "$repository"
else
  printf '{"provider":"unknown","remote":"%s","reason":"Select a canonical GitHub HTTPS or SSH remote; DIM native Git uses its own proposal, review and promotion authority."}\n' "$remote"
  exit 3
fi
