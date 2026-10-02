#!/usr/bin/env bash
set -euo pipefail

workspace="${1:-external-dev}"
ingress="${DIM_EXTERNAL_URL_INGRESS:-local-http}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" external-url discover --workspace "$workspace" --json
"$dim_bin" external-url request \
  --workspace "$workspace" \
  --ingress "$ingress" \
  --container dev \
  --port 8080 \
  --json
"$dim_bin" external-url request \
  --workspace "$workspace" \
  --ingress "$ingress" \
  --container dev \
  --container deep \
  --port 5678 \
  --json
