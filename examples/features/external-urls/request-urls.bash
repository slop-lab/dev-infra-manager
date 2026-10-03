#!/usr/bin/env bash
set -euo pipefail

workspace="${1:-external-dev}"
ingress="${DIM_EXTERNAL_URL_INGRESS:-local-http}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" workspace exec "$workspace" -- dim-development-service request-url \
  --ingress "$ingress" \
  --container dev \
  --port 8080
"$dim_bin" workspace exec "$workspace" -- dim-development-service request-url \
  --ingress "$ingress" \
  --container dev \
  --container deep \
  --port 5678
