#!/usr/bin/env bash
set -euo pipefail
: "${DIM_SHARED_INGRESS_CONFIG:?set an absolute private control-plane ingress configuration file}"
exec "${DIM_CONTROL_PLANE_BIN:-dim-control-plane}" run "$DIM_SHARED_INGRESS_CONFIG"
