#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
# shellcheck source=lib/runtime-backends.bash
source "$script_dir/lib/runtime-backends.bash"
backend="${1:-sysbox}"
if ! dim_is_runtime_backend "$backend"; then
  echo "usage: $0 [$(dim_runtime_backend_choices)]" >&2
  exit 2
fi
JUST_BIN="${JUST_BIN:-}"
DEV_INFRA_MISE_ACTIVE="${DEV_INFRA_MISE_ACTIVE:-0}"

if [[ "$DEV_INFRA_MISE_ACTIVE" != "1" ]] && command -v mise >/dev/null 2>&1; then
  cd "$repo_root"
  mise install
  JUST_BIN="$(mise which just)"
  exec mise exec -- env \
    DEV_INFRA_MISE_ACTIVE=1 \
    JUST_BIN="$JUST_BIN" \
    bash "$0" "$backend"
fi

if [[ "$DEV_INFRA_MISE_ACTIVE" == "1" ]]; then
  sudo apt-get update
  sudo apt-get install -y git openssh-client
  [[ -n "$JUST_BIN" ]] || JUST_BIN="$(command -v just)"
else
  # Ubuntu 24.04's distro Node.js is outside DIM's supported toolchain.
  # Reuse the reviewed source-tool installer rather than a global npm install.
  source "$script_dir/../lib/bootstrap-ubuntu-pins.bash"
  sudo /usr/bin/bash "$script_dir/lib/install-source-tools-ubuntu.bash"
  export PATH="$dim_source_tools_root/bin:$dim_node_root/bin:$PATH"
  JUST_BIN="$dim_source_tools_root/bin/just"
fi

if [[ ! -x "$JUST_BIN" ]]; then
  echo "just executable is not available: $JUST_BIN" >&2
  exit 1
fi

bash "${script_dir}/install-host-ubuntu.bash" "$backend"

cd "$repo_root"
pnpm install --frozen-lockfile
export JUST_UNSTABLE=1
"$JUST_BIN" check-source
"$JUST_BIN" verify plugin-install
"$JUST_BIN" build-workspace-image

set +e
"$JUST_BIN" run-cli doctor
doctor_rc=$?
set -e

if [[ "$doctor_rc" -ne 0 ]]; then
  cat >&2 <<'EOF'

Bootstrap completed, but doctor reported a host runtime gap for the selected backend.

Review the doctor output above before creating agent workspaces.
EOF
  exit "$doctor_rc"
fi

echo "Bootstrap completed successfully."
