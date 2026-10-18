#!/usr/bin/env bash
set -uo pipefail

usage="usage: source-gate-preflight.bash [--require-artifacts] [REPOSITORY_ROOT]"
require_artifacts=false
if [[ "${1:-}" == "--require-artifacts" ]]; then
  require_artifacts=true
  shift
fi
if (( $# > 1 )); then
  printf '%s\n' "$usage" >&2
  exit 2
fi

repository_root="${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"
temporary_root="${TMPDIR:-/tmp}"
failures=()

report_version() {
  local tool="$1"
  local expected="$2"
  local origin="$3"
  local command_output
  if ! command -v "$tool" >/dev/null 2>&1; then
    failures+=("$tool is unavailable; expected $expected (pin source: $origin)")
    return
  fi
  command_output="$($tool --version 2>&1)"
  case "$tool" in
    node)
      if [[ ! "$command_output" =~ ^v(24|26)\. ]]; then
        failures+=("Node.js $command_output is unsupported; expected major 24 or 26 (pin source: package.json engines.node)")
      fi
      ;;
    pnpm)
      if [[ "$command_output" != "10.13.1" ]]; then
        failures+=("pnpm $command_output is unsupported; expected exactly 10.13.1 (pin source: package.json packageManager)")
      fi
      ;;
  esac
}

if [[ ! -x /usr/bin/git ]]; then
  failures+=("fixture Git /usr/bin/git is unavailable; expected exactly 2.43.0 (pin source: tests/packages/native-git/test/nativeGitHarness.ts)")
else
  fixture_git_version="$(/usr/bin/git --version 2>&1)"
  if [[ "$fixture_git_version" != "git version 2.43.0" ]]; then
    failures+=("fixture Git /usr/bin/git reports ${fixture_git_version#git version }; expected exactly 2.43.0 (pin source: tests/packages/native-git/test/nativeGitHarness.ts)")
  fi
fi
report_version node "major 24 or 26" "package.json engines.node"
report_version pnpm "exactly 10.13.1" "package.json packageManager"

temporary_probe=""
temporary_chain_trusted=true
caller_uid="$(id -u)"
if [[ "$temporary_root" != /* ]]; then
  failures+=("temporary root $temporary_root is not absolute")
  temporary_chain_trusted=false
else
  current="/"
  IFS='/' read -r -a temporary_components <<<"${temporary_root#/}"
  for component in "${temporary_components[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current%/}/$component"
    if [[ -L "$current" || ! -d "$current" ]]; then
      failures+=("untrusted temporary directory ancestor $current: expected a real directory")
      temporary_chain_trusted=false
      continue
    fi
    read -r ancestor_uid ancestor_mode < <(stat -c '%u %a' "$current")
    if [[ "$ancestor_uid" != "0" && "$ancestor_uid" != "$caller_uid" ]]; then
      failures+=("untrusted temporary directory ancestor $current: owned by UID $ancestor_uid, expected root or caller UID $caller_uid")
      temporary_chain_trusted=false
    fi
    mode_value=$((8#$ancestor_mode))
    sticky_root_exception=false
    if [[ "$ancestor_uid" == "0" ]] && (( (mode_value & 01000) != 0 )); then
      sticky_root_exception=true
    fi
    if (( (mode_value & 0022) != 0 )) && ! $sticky_root_exception; then
      printf -v displayed_mode '%04o' "$mode_value"
      failures+=("untrusted temporary directory ancestor $current: group/world-writable mode $displayed_mode")
      temporary_chain_trusted=false
    fi
  done
fi

if ! $temporary_chain_trusted; then
  :
elif [[ ! -d "$temporary_root" || ! -w "$temporary_root" ]]; then
  failures+=("temporary root $temporary_root is not a writable directory")
elif temporary_probe="$(mktemp -d "$temporary_root/dim-source-gate.XXXXXX" 2>/dev/null)"; then
  probe_uid="$(stat -c '%u' "$temporary_probe")"
  if [[ "$probe_uid" != "$caller_uid" ]]; then
    failures+=("temporary probe $temporary_probe is owned by UID $probe_uid, not caller UID $caller_uid")
  fi
  if ! (umask 077 && : >"$temporary_probe/write-probe") 2>/dev/null; then
    failures+=("temporary probe $temporary_probe is not writable by the caller")
  fi
  rm -rf -- "$temporary_probe"
else
  failures+=("temporary root $temporary_root cannot create a caller-owned directory")
fi

ownership_parent=""
ownership_probe=""
if ownership_parent="$(mktemp -d /tmp/dim-source-gate-ownership.XXXXXX 2>/dev/null)"; then
  ownership_probe="$ownership_parent/root-owned"
  mkdir "$ownership_probe"
  caller_gid="$(id -g)"
  if ! /usr/bin/chown 0:0 "$ownership_probe" 2>/dev/null; then
    failures+=("cannot create a disposable root:root fixture with chown 0:0 (required by verification/test/qemuServiceFilesystem.test.ts)")
  else
    root_identity="$(stat -c '%u:%g' "$ownership_probe")"
    if [[ "$root_identity" != "0:0" ]]; then
      failures+=("disposable ownership probe reported $root_identity after chown 0:0 (required by verification/test/qemuServiceFilesystem.test.ts)")
    fi
    if ! /usr/bin/chown "$caller_uid:$caller_gid" "$ownership_probe" 2>/dev/null; then
      failures+=("disposable root:root fixture could not be restored to caller ownership")
    fi
  fi
  rmdir "$ownership_probe" 2>/dev/null || failures+=("disposable root-ownership probe could not be cleaned: $ownership_probe")
  rmdir "$ownership_parent" 2>/dev/null || failures+=("disposable root-ownership probe parent could not be cleaned: $ownership_parent")
else
  failures+=("cannot create the disposable root-ownership capability probe under /tmp")
fi

if $require_artifacts; then
  artifacts=(
    "core/packages/contracts/external-url/dist/index.js"
    "core/packages/controller-proxy/dist/index.js"
    "core/packages/controller-proxy/dist/development-service-cli.js"
    "core/packages/core/dist/index.js"
    "core/packages/managed/dist/index.js"
    "core/packages/managed/dist/nativeOrdinaryServiceCli.js"
    "core/packages/managed/dist/nativeOrdinaryBundleConfig.js"
    "core/packages/managed/dist/nativeOrdinaryIdleService.js"
    "core/packages/core/dist/package.json"
    "core/packages/native-git/dist/serviceCli.js"
    "core/packages/native-git/dist/cli.js"
    "core/packages/native-git/dist/package.json"
    "core/packages/cli/dist/cli.js"
    "core/packages/cli/dist/package.json"
  )
  for artifact in "${artifacts[@]}"; do
    [[ -f "$repository_root/$artifact" ]] || failures+=("missing test artifact: $artifact")
  done
fi

if (( ${#failures[@]} > 0 )); then
  printf 'source gate preflight found %d prerequisite issue(s):\n' "${#failures[@]}" >&2
  printf '  - %s\n' "${failures[@]}" >&2
  printf '\nInspect the host without mutation:\n' >&2
  printf '  /usr/bin/git --version\n  node --version\n  pnpm --version\n  stat -c '\''%%u:%%g %%a %%n'\'' "${TMPDIR:-/tmp}"\n' >&2
  printf 'Use the reviewed pinned isolated test environment that provides /usr/bin/git 2.43.0; do not upgrade, downgrade, or substitute an unattested Git binary.\n' >&2
  printf 'Root-ownership fixture tests must run in that reviewed disposable container or VM; do not run the source gate with sudo on a live host.\n' >&2
  printf 'For compiler-only feedback on supported Node.js 24/26 hosts, run: just typecheck\n' >&2
  printf 'No repository files were changed. Do not use sudo.\n' >&2
  exit 1
fi

printf 'source gate prerequisites satisfied (/usr/bin/git 2.43.0, Node.js 24/26, pnpm 10.13.1, trusted caller temporary directory, disposable root:root fixture capability%s)\n' \
  "$($require_artifacts && printf ', test artifacts present')"
