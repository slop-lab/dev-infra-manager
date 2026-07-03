#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
PNPM_VERSION="${PNPM_VERSION:-10.13.1}"

sudo apt-get update
sudo apt-get install -y git nodejs npm just

if ! command -v pnpm >/dev/null 2>&1 || [[ "$(pnpm --version)" != "$PNPM_VERSION" ]]; then
  sudo npm install -g "pnpm@${PNPM_VERSION}"
fi

"${script_dir}/install-host-ubuntu.sh"

cd "$repo_root"
pnpm install --frozen-lockfile
just verify
just build-agent-image
just build-secret-example

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
