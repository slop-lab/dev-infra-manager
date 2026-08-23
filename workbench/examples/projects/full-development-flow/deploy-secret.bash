#!/usr/bin/env bash
set -euo pipefail

workspace="${1:-full-dev}"
: "${EXAMPLE_SECRET:?set EXAMPLE_SECRET for this deployment}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" exec "$workspace" -- \
  env EXAMPLE_SECRET="$EXAMPLE_SECRET" sh ops/secret-service.sh deploy-secret
