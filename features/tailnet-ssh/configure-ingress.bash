#!/usr/bin/env bash
set -euo pipefail

dim_bin="${DIM_BIN:-dim}"
listen_port="${DIM_TAILNET_SSH_PORT:-49152}"

"$dim_bin" external-url ingress add tailscale \
  --name tailnet-ssh \
  --description "Tailnet SSH TCP listener" \
  --scheme tcp \
  --listen-port "$listen_port"
