#!/usr/bin/env bash
set -euo pipefail

workspace="${1:-external-dev}"
dim_bin="${DIM_BIN:-dim}"
ingress="${DIM_EXTERNAL_URL_INGRESS:-local-http}"

"$dim_bin" external-url discover --workspace "$workspace"
"$dim_bin" external-url request --workspace "$workspace" \
  --ingress "$ingress" --name dev --container dev --port 8080
"$dim_bin" external-url request --workspace "$workspace" \
  --ingress "$ingress" --name deep \
  --container dev --container deep --port 5678
