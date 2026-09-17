#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
readme="$repo_root/README.md"
work_dir="$(mktemp -d /tmp/dim-workspace-user-setup-remote-bootstrap.XXXXXX)"
system_path="$PATH"
begin_marker='# DIM_REMOTE_BOOTSTRAP_BEGIN'
end_marker='# DIM_REMOTE_BOOTSTRAP_END'

cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

extract_bootstrap() {
  local source="$1"
  local output="$2"
  local line
  local line_number=0
  local begin_line=0
  local end_line=0
  local begin_count=0
  local end_count=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    case "$line" in
      "$begin_marker")
        begin_count=$((begin_count + 1))
        begin_line="$line_number"
        ;;
      "$end_marker")
        end_count=$((end_count + 1))
        end_line="$line_number"
        ;;
    esac
  done <"$source"

  if [[ "$begin_count" -ne 1 || "$end_count" -ne 1 ]]; then
    printf 'expected exactly one remote bootstrap marker pair in %s\n' "$source" >&2
    return 1
  fi
  if [[ "$begin_line" -ge "$end_line" ]]; then
    printf 'remote bootstrap markers are reversed in %s\n' "$source" >&2
    return 1
  fi

  awk -v first="$((begin_line + 1))" -v last="$((end_line - 1))" \
    'NR >= first && NR <= last' "$source" >"$output"
}

assert_extraction_rejected() {
  local source="$1"
  if extract_bootstrap "$source" "$work_dir/rejected-bootstrap.bash" 2>/dev/null; then
    printf 'remote bootstrap extraction unexpectedly accepted %s\n' "$source" >&2
    exit 1
  fi
}

mkdir -p "$work_dir/extraction-fixtures"
printf '%s\n' 'no markers' >"$work_dir/extraction-fixtures/missing"
printf '%s\n' "$begin_marker" "$begin_marker" '()' "$end_marker" \
  >"$work_dir/extraction-fixtures/duplicate-begin"
printf '%s\n' "$begin_marker" '()' "$end_marker" "$end_marker" \
  >"$work_dir/extraction-fixtures/duplicate-end"
printf '%s\n' "$end_marker" '()' "$begin_marker" \
  >"$work_dir/extraction-fixtures/reversed"

for malformed in "$work_dir"/extraction-fixtures/*; do
  assert_extraction_rejected "$malformed"
done

bootstrap="$work_dir/remote-bootstrap.bash"
extract_bootstrap "$readme" "$bootstrap"
bash -n "$bootstrap"

fixture_dir="$work_dir/fixtures"
tools_dir="$work_dir/tools"
downloads_dir="$work_dir/downloads"
download_log="$work_dir/downloads.log"
dim_log="$work_dir/dim.log"
captured_setup="$work_dir/captured-setup.bash"
captured_launcher="$work_dir/captured-launcher.bash"
commit='0123456789abcdef0123456789abcdef01234567'
expected_base="https://raw.githubusercontent.com/slop-lab/dev-infra-manager/${commit}/scripts"
mkdir -p "$fixture_dir" "$tools_dir" "$downloads_dir"

cat >"$fixture_dir/workspace-user-setup.bash" <<'EOF'
#!/usr/bin/env bash
printf 'workspace-user-setup remote bootstrap fixture\n'
EOF
cat >"$fixture_dir/opencode-web.bash" <<'EOF'
#!/usr/bin/env bash
printf 'opencode-web remote bootstrap fixture\n'
EOF
(
  cd -- "$fixture_dir"
  sha256sum workspace-user-setup.bash >workspace-user-setup.bash.sha256.good
  sha256sum opencode-web.bash >opencode-web.bash.sha256.good
)
printf '%064d  workspace-user-setup.bash\n' 0 \
  >"$fixture_dir/workspace-user-setup.bash.sha256.bad"
cp "$fixture_dir/opencode-web.bash.sha256.good" "$fixture_dir/opencode-web.bash.sha256.bad"

cat >"$tools_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 7 || "$1" != --fail || "$2" != --silent || "$3" != --show-error || \
  "$4" != --location || "$5" != --output ]]; then
  printf 'unexpected curl invocation:' >&2
  printf ' %q' "$@" >&2
  printf '\n' >&2
  exit 90
fi

output="$6"
url="$7"
case "$url" in
  "$REMOTE_BOOTSTRAP_EXPECTED_BASE/workspace-user-setup.bash")
    source="$REMOTE_BOOTSTRAP_FIXTURES/workspace-user-setup.bash"
    ;;
  "$REMOTE_BOOTSTRAP_EXPECTED_BASE/workspace-user-setup.bash.sha256")
    source="$REMOTE_BOOTSTRAP_FIXTURES/workspace-user-setup.bash.sha256.${REMOTE_BOOTSTRAP_CHECKSUM_MODE}"
    ;;
  "$REMOTE_BOOTSTRAP_EXPECTED_BASE/opencode-web.bash")
    source="$REMOTE_BOOTSTRAP_FIXTURES/opencode-web.bash"
    ;;
  "$REMOTE_BOOTSTRAP_EXPECTED_BASE/opencode-web.bash.sha256")
    source="$REMOTE_BOOTSTRAP_FIXTURES/opencode-web.bash.sha256.${REMOTE_BOOTSTRAP_CHECKSUM_MODE}"
    ;;
  *)
    printf 'unexpected curl URL: %s\n' "$url" >&2
    exit 91
    ;;
esac

printf '%s\t%s\n' "$output" "$url" >>"$REMOTE_BOOTSTRAP_DOWNLOAD_LOG"
cp -- "$source" "$output"
EOF

cat >"$tools_dir/dim" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

matches_invocation() {
  local expected_name="$1"
  shift
  local -n expected="$expected_name"
  local actual=("$@")

  [[ "${#actual[@]}" -eq "${#expected[@]}" ]] || return 1
  for index in "${!expected[@]}"; do
    [[ "${actual[$index]}" == "${expected[$index]}" ]] || return 1
  done
}

setup=(workspace run dim-dev bash -- -s)
if matches_invocation setup "$@"; then
  printf '%s\n' 'workspace run dim-dev bash -- -s' >>"$REMOTE_BOOTSTRAP_DIM_LOG"
  if [[ ! -e "$REMOTE_BOOTSTRAP_CAPTURED_SETUP" ]]; then
    cat >"$REMOTE_BOOTSTRAP_CAPTURED_SETUP"
  elif [[ ! -e "$REMOTE_BOOTSTRAP_CAPTURED_LAUNCHER" ]]; then
    cat >"$REMOTE_BOOTSTRAP_CAPTURED_LAUNCHER"
  else
    printf 'dim received bootstrap bytes more than twice\n' >&2
    exit 94
  fi
else
  printf 'unexpected dim invocation:' >&2
  printf ' %q' "$@" >&2
  printf '\n' >&2
  exit 92
fi
EOF

chmod 0700 "$tools_dir/curl" "$tools_dir/dim"

run_bootstrap() {
  local checksum_mode="$1"
  local stdout="$2"
  local stderr="$3"

  env \
    PATH="$tools_dir:$system_path" \
    TMPDIR="$downloads_dir" \
    DIM_DEVELOPMENT_COMMIT="$commit" \
    REMOTE_BOOTSTRAP_CHECKSUM_MODE="$checksum_mode" \
    REMOTE_BOOTSTRAP_FIXTURES="$fixture_dir" \
    REMOTE_BOOTSTRAP_EXPECTED_BASE="$expected_base" \
    REMOTE_BOOTSTRAP_DOWNLOAD_LOG="$download_log" \
    REMOTE_BOOTSTRAP_DIM_LOG="$dim_log" \
    REMOTE_BOOTSTRAP_CAPTURED_SETUP="$captured_setup" \
    REMOTE_BOOTSTRAP_CAPTURED_LAUNCHER="$captured_launcher" \
    bash --noprofile --norc "$bootstrap" >"$stdout" 2>"$stderr"
}

if run_bootstrap bad "$work_dir/bad.stdout" "$work_dir/bad.stderr"; then
  printf 'remote bootstrap unexpectedly accepted a bad checksum\n' >&2
  exit 1
fi

mapfile -t bad_downloads <"$download_log"
if [[ "${#bad_downloads[@]}" -ne 4 ]]; then
  printf 'bad-checksum attempt made %s downloads instead of 4\n' "${#bad_downloads[@]}" >&2
  exit 1
fi
bad_script="${bad_downloads[0]%%$'\t'*}"
bad_checksum="${bad_downloads[1]%%$'\t'*}"
bad_setup_dir="$(dirname -- "$bad_script")"
[[ "$(dirname -- "$bad_checksum")" == "$bad_setup_dir" ]]
[[ ! -e "$bad_setup_dir" ]]
[[ ! -e "$dim_log" ]]
[[ ! -e "$captured_setup" ]]
[[ ! -e "$captured_launcher" ]]

run_bootstrap good "$work_dir/good.stdout" "$work_dir/good.stderr"

mapfile -t all_downloads <"$download_log"
if [[ "${#all_downloads[@]}" -ne 8 ]]; then
  printf 'failure and retry made %s downloads instead of 8\n' "${#all_downloads[@]}" >&2
  exit 1
fi
retry_script="${all_downloads[4]%%$'\t'*}"
retry_checksum="${all_downloads[5]%%$'\t'*}"
retry_setup_dir="$(dirname -- "$retry_script")"
[[ "$(dirname -- "$retry_checksum")" == "$retry_setup_dir" ]]
[[ "$retry_setup_dir" != "$bad_setup_dir" ]]
[[ ! -e "$retry_setup_dir" ]]

mapfile -t dim_invocations <"$dim_log"
if [[ "${#dim_invocations[@]}" -ne 2 || \
  "${dim_invocations[0]}" != 'workspace run dim-dev bash -- -s' || \
  "${dim_invocations[1]}" != 'workspace run dim-dev bash -- -s' ]]; then
  printf 'retry did not invoke DIM setup then OpenCode launch exactly once each\n' >&2
  exit 1
fi
cmp -s "$fixture_dir/workspace-user-setup.bash" "$captured_setup"
cmp -s "$fixture_dir/opencode-web.bash" "$captured_launcher"

printf '%s\n' 'workspace-user-setup-remote-bootstrap-smoke-ok'
