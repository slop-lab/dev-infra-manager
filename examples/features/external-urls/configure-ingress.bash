#!/usr/bin/env bash
set -euo pipefail

dim_bin="${DIM_BIN:-dim}"
ingress="${DIM_EXTERNAL_URL_INGRESS:-local-http}"
domain="${DIM_EXTERNAL_URL_DOMAIN:-host.tail.test}"
public_port="${DIM_EXTERNAL_URL_PORT:-8080}"
listen_host="${DIM_EXTERNAL_URL_LISTEN_HOST:-0.0.0.0}"
listen_port="${DIM_EXTERNAL_URL_LISTEN_PORT:-8080}"

"$dim_bin" external-url ingress add http \
  --name "$ingress" \
  --description "Local HTTP development URL" \
  --scheme http \
  --domain "$domain" \
  --public-port "$public_port" \
  --listen-host "$listen_host" \
  --listen-port "$listen_port" \
  --upstream-mode container-ip
