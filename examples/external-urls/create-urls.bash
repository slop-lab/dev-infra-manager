#!/usr/bin/env bash
set -euo pipefail

workspace="${1:-external-dev}"

dim external-url discover --workspace "$workspace"
dim external-url create --workspace "$workspace" \
  --ingress local-http --service dev --container dev --port 8080
dim external-url create --workspace "$workspace" \
  --ingress local-http --service deep \
  --container dev --container deep --port 5678
