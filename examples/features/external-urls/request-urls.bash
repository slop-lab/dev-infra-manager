#!/usr/bin/env bash
set -euo pipefail

workspace="${1:-external-dev}"
ingress="${DIM_EXTERNAL_URL_INGRESS:-local-http}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" external-url request --workspace "$workspace" \
  --ingress "$ingress" --subdomain "$workspace--app" \
  --port 3000 --protocol http --json
