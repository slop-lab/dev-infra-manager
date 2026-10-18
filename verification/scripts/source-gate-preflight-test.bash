#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
preflight="$workspace_root/verification/scripts/source-gate-preflight.bash"
fixture="$(mktemp -d /tmp/dim-source-preflight-test.XXXXXX)"
trap 'rm -rf -- "$fixture"' EXIT

fail() {
  printf 'source-gate-preflight-test: %s\n' "$1" >&2
  exit 1
}

write_tool() {
  local name="$1"
  local output="$2"
  printf '#!/usr/bin/env bash\nprintf '\''%%s\\n'\'' '\''%s'\''\n' "$output" >"$fixture/tools/$name"
  chmod 0755 "$fixture/tools/$name"
}

mkdir -p "$fixture/tools" "$fixture/root"
write_tool git "git version 2.53.0"
write_tool node "v25.1.0"
write_tool pnpm "11.0.0"

set +e
bad_output="$(PATH="$fixture/tools:/usr/bin:/bin" TMPDIR="$fixture/missing-temp" bash "$preflight" --require-artifacts "$fixture/root" 2>&1)"
bad_status=$?
set -e
[[ $bad_status -ne 0 ]] || fail "unsupported prerequisites unexpectedly passed"
for expected in \
  "Node.js v25.1.0 is unsupported; expected major 24 or 26" \
  "pnpm 11.0.0 is unsupported; expected exactly 10.13.1" \
  "untrusted temporary directory ancestor $fixture/missing-temp: expected a real directory" \
  "missing test artifact: core/packages/managed/dist/nativeOrdinaryServiceCli.js" \
  "missing test artifact: core/packages/managed/dist/nativeGitServiceCli.js" \
  "missing test artifact: core/packages/cli/dist/cli.js"
do
  [[ "$bad_output" == *"$expected"* ]] || fail "aggregate report omitted: $expected"
done
[[ "$bad_output" != *"Git 2.53.0"* ]] || fail "PATH Git shim influenced the absolute fixture Git check"
[[ "$bad_output" == *"No repository files were changed. Do not use sudo."* ]] || fail "failure did not give safe remediation guidance"

write_tool git "git version 2.43.0"
write_tool node "v24.19.0"
write_tool pnpm "10.13.1"
mkdir -p \
  "$fixture/root/core/packages/contracts/external-url/dist" \
  "$fixture/root/core/packages/core/dist" \
  "$fixture/root/core/packages/managed/dist" \
  "$fixture/root/core/packages/native-git/dist" \
  "$fixture/root/core/packages/cli/dist" \
  "$fixture/temp"
touch \
  "$fixture/root/core/packages/contracts/external-url/dist/index.js" \
  "$fixture/root/core/packages/core/dist/index.js" \
  "$fixture/root/core/packages/managed/dist/index.js" \
  "$fixture/root/core/packages/managed/dist/nativeOrdinaryServiceCli.js" \
  "$fixture/root/core/packages/managed/dist/nativeOrdinaryBundleConfig.js" \
  "$fixture/root/core/packages/core/dist/package.json" \
  "$fixture/root/core/packages/managed/dist/nativeGitServiceCli.js" \
  "$fixture/root/core/packages/native-git/dist/cli.js" \
  "$fixture/root/core/packages/native-git/dist/package.json" \
  "$fixture/root/core/packages/cli/dist/cli.js" \
  "$fixture/root/core/packages/cli/dist/package.json"

mkdir -p "$fixture/unsafe/world/temp"
chmod 0777 "$fixture/unsafe/world"
set +e
unsafe_output="$(PATH="$fixture/tools:/usr/bin:/bin" TMPDIR="$fixture/unsafe/world/temp" bash "$preflight" "$fixture/root" 2>&1)"
unsafe_status=$?
set -e
[[ $unsafe_status -ne 0 ]] || fail "unsafe temporary ancestor unexpectedly passed"
[[ "$unsafe_output" == *"untrusted temporary directory ancestor $fixture/unsafe/world: group/world-writable mode 0777"* ]] \
  || fail "unsafe temporary ancestor was not reported"

[[ "$(id -u)" == "0" ]] || fail "passing profile requires the reviewed root-capable test environment"
command -v setpriv >/dev/null 2>&1 || fail "setpriv is required to test the unprivileged profile"
cp "$preflight" "$fixture/unprivileged-preflight.bash"
chmod 0755 "$fixture" "$fixture/unprivileged-preflight.bash"
set +e
ownership_output="$(setpriv --reuid=65534 --regid=65534 --clear-groups \
  env PATH="$fixture/tools:/usr/bin:/bin" TMPDIR=/tmp bash "$fixture/unprivileged-preflight.bash" 2>&1)"
ownership_status=$?
set -e
[[ $ownership_status -ne 0 ]] || fail "missing root-ownership fixture capability unexpectedly passed"
[[ "$ownership_output" == *"cannot create a disposable root:root fixture with chown 0:0"* ]] \
  || fail "root-ownership fixture capability was not reported"
[[ "$ownership_output" == *"verification/test/qemuServiceFilesystem.test.ts"* ]] \
  || fail "root-ownership diagnostic omitted its test source"
[[ "$ownership_output" == *"reviewed disposable container or VM; do not run the source gate with sudo on a live host"* ]] \
  || fail "root-ownership diagnostic omitted safe environment guidance"

PATH="$fixture/tools:/usr/bin:/bin" TMPDIR="$fixture/temp" bash "$preflight" --require-artifacts "$fixture/root" >/dev/null

recipe="$(awk '/^check-source-native:/{capture=1} capture{print} capture && /^$/{exit}' "$workspace_root/justfile")"
required_steps=(
  "bash verification/scripts/source-gate-preflight.bash"
  "bash verification/scripts/source-gate-preflight-test.bash"
  "just typecheck"
  "pnpm --filter @slop-lab/dim-contracts-external-url run build"
  "pnpm --filter @slop-lab/dim-core run build"
  "pnpm --filter @slop-lab/dim-native-git run build"
  "pnpm --filter @slop-lab/dim-cli run build"
  "bash verification/scripts/source-gate-preflight.bash --require-artifacts"
  "just test"
  "just build-packages"
)
previous=-1
for step in "${required_steps[@]}"; do
  line="$(grep -nFx "    $step" <<<"$recipe" | cut -d: -f1 || true)"
  [[ -n "$line" ]] || fail "check-source-native omitted step: $step"
  (( line > previous )) || fail "check-source-native step is out of order: $step"
  previous="$line"
done

printf 'source gate preflight regressions passed\n'
