#!/usr/bin/env bash
set -euo pipefail

dim_bin="${DIM_BIN:-dim}"
ingress="${DIM_EXTERNAL_URL_INGRESS:-local-http}"
domain="${DIM_EXTERNAL_URL_DOMAIN:-dev.test}"
public_port="${DIM_EXTERNAL_URL_PORT:-8080}"
listen_host="${DIM_EXTERNAL_URL_LISTEN_HOST:-127.0.0.1}"
listen_port="${DIM_EXTERNAL_URL_LISTEN_PORT:-8080}"

"$dim_bin" external-url ingress add http \
  --name "$ingress" \
  --description "Local HTTP development URL" \
  --scheme http \
  --domain "$domain" \
  --public-port "$public_port" \
  --listen-host "$listen_host" \
  --listen-port "$listen_port" \
  --require-approval
