# Fixture orchestration: installation is complete before service readiness begins.
examples_prepare_and_start_control_plane() {
  local runtime=/home/dim/dim/example-control-plane-runtime
  printf '[examples] phase=control-plane-install log-root=%s\n' "$CHECK_OUTPUT_ROOT"
  check_output_run control-plane-install timeout --signal=TERM --kill-after=30s 1800s "${BOOTSTRAP_SSH[@]}" bash -s -- "$runtime" <<'REMOTE' || return "$?"
set -euo pipefail
export PATH=/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin:/usr/local/lib/dim-qemu-node-24.19.0/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd /home/dim/dim/workbench
export DIM_PRACTICAL_CI_REQUIRED=1 DIM_EXAMPLE_PACKAGE_BUNDLE=/home/dim/dim/example-packages
mkdir -m 0700 -- "$1"
bash scripts/examples/prepare-installed-control-plane.bash "$1"
REMOTE
  printf '[examples] phase=control-plane-serve log=%s/separate-control-plane.log\n' "$BOOTSTRAP_EVIDENCE_ROOT"
  timeout --signal=TERM --kill-after=30s 7200s "${BOOTSTRAP_SSH[@]}" \
    'export PATH=/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin:/usr/local/lib/dim-qemu-node-24.19.0/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd /home/dim/dim/workbench; export DIM_PRACTICAL_CI_REQUIRED=1 DIM_EXAMPLE_PACKAGE_BUNDLE=/home/dim/dim/example-packages DIM_EXAMPLE_REMOTE_SETUP=/home/dim/dim/example-operator; exec bash scripts/examples/serve-installed-control-plane.bash /home/dim/dim/example-control-plane-runtime' \
    >"$BOOTSTRAP_EVIDENCE_ROOT/separate-control-plane.log" 2>&1 &
  EXAMPLES_CP_SSH_PID=$!
  EXAMPLES_CP_SSH_START="$(cut -d' ' -f22 "/proc/$EXAMPLES_CP_SSH_PID/stat")"
}
