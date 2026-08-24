#!/usr/bin/env bash
set -euo pipefail

dim_bin="${DIM_BIN:-dim}"
domain="${DIM_EXTERNAL_URL_DOMAIN:-host.tail.test}"
listen_host="${DIM_EXTERNAL_URL_LISTEN_HOST:-127.0.0.1}"
listen_port="${DIM_EXTERNAL_URL_LISTEN_PORT:-8080}"

"$dim_bin" external-url ingress add http \
  --name local-http \
  --description "Single-repository development URL" \
  --scheme http \
  --domain "$domain" \
  --public-port "$listen_port" \
  --listen-host "$listen_host" \
  --listen-port "$listen_port" \
  --upstream-mode container-ip
