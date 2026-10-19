#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  printf 'usage: source-gate-preflight.bash\n' >&2
  exit 2
fi

failures=()
for tool in node pnpm just python3; do
  command -v "$tool" >/dev/null 2>&1 || failures+=("required tool is unavailable: $tool")
done
[[ -x /usr/bin/git ]] || failures+=("Git is unavailable at /usr/bin/git")
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version)"
  [[ "$node_version" =~ ^v(24|26)\. ]] || failures+=("unsupported Node.js $node_version; use major 24 or 26")
fi
if command -v pnpm >/dev/null 2>&1; then
  pnpm_version="$(pnpm --version)"
  [[ "$pnpm_version" == 10.13.1 ]] || failures+=("unsupported pnpm $pnpm_version; use packageManager version 10.13.1")
fi

temporary_root="${TMPDIR:-/tmp}"
if [[ "$temporary_root" != /* || ! -d "$temporary_root" || ! -w "$temporary_root" ]]; then
  failures+=("TMPDIR must name an absolute writable directory: $temporary_root")
elif probe="$(mktemp -d "$temporary_root/dim-source-gate.XXXXXX" 2>/dev/null)"; then
  rmdir -- "$probe"
else
  failures+=("cannot create a temporary directory under $temporary_root")
fi

if (( ${#failures[@]} )); then
  printf 'source gate prerequisites:\n' >&2
  printf '  - %s\n' "${failures[@]}" >&2
  exit 1
fi
printf 'source gate prerequisites satisfied\n'
