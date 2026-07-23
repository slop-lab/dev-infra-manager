#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
PNPM_VERSION="${PNPM_VERSION:-10.13.1}"
JUST_BIN="${JUST_BIN:-}"
DEV_INFRA_MISE_ACTIVE="${DEV_INFRA_MISE_ACTIVE:-0}"

if [[ "$DEV_INFRA_MISE_ACTIVE" != "1" ]] && command -v mise >/dev/null 2>&1; then
  cd "$repo_root"
  mise install
  JUST_BIN="$(mise which just)"
  exec mise exec -- env \
    DEV_INFRA_MISE_ACTIVE=1 \
    JUST_BIN="$JUST_BIN" \
    PNPM_VERSION="$PNPM_VERSION" \
    bash "$0"
fi

sudo apt-get update

if [[ "$DEV_INFRA_MISE_ACTIVE" == "1" ]]; then
  sudo apt-get install -y git
else
  sudo apt-get install -y git nodejs npm
fi

if [[ -z "$JUST_BIN" ]] && command -v just >/dev/null 2>&1; then
  JUST_BIN="$(command -v just)"
fi

if [[ -z "$JUST_BIN" ]]; then
  sudo apt-get install -y just
  JUST_BIN="$(command -v just)"
fi

if [[ ! -x "$JUST_BIN" ]]; then
  echo "just executable is not available: $JUST_BIN" >&2
  exit 1
fi

if [[ "$DEV_INFRA_MISE_ACTIVE" != "1" ]] && \
  { ! command -v pnpm >/dev/null 2>&1 || [[ "$(pnpm --version)" != "$PNPM_VERSION" ]]; }; then
  sudo npm install -g "pnpm@${PNPM_VERSION}"
fi

"${script_dir}/install-host-ubuntu.sh"

cd "$repo_root"
pnpm install --frozen-lockfile
"$JUST_BIN" verify
"$JUST_BIN" build-agent-image
"$JUST_BIN" build-secret-example

set +e
pnpm run cli -- doctor
doctor_rc=$?
set -e

if [[ "$doctor_rc" -ne 0 ]]; then
  cat >&2 <<'EOF'

Bootstrap completed, but doctor reported host runtime gaps.
This usually means the current host does not expose one of:
  - running Sysbox services
  - loop device setup
  - /dev/kvm

Review the doctor output above before running agent jobs.
EOF
  exit "$doctor_rc"
fi

echo "Bootstrap completed successfully."
