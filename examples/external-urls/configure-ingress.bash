#!/usr/bin/env bash
set -euo pipefail

dim_bin="${DIM_BIN:-dim}"
ingress="${DIM_EXTERNAL_URL_INGRESS:-local-http}"
domain="${DIM_EXTERNAL_URL_DOMAIN:-host.tail.test}"
public_port="${DIM_EXTERNAL_URL_PORT:-8080}"
listen_host="${DIM_EXTERNAL_URL_LISTEN_HOST:-0.0.0.0}"
listen_port="${DIM_EXTERNAL_URL_LISTEN_PORT:-8080}"

argument="$(jq -cn \
  --arg domain "$domain" \
  --arg listenHost "$listen_host" \
  --argjson publicPort "$public_port" \
  --argjson listenPort "$listen_port" \
  '{domain:$domain,publicPort:$publicPort,listenHost:$listenHost,listenPort:$listenPort,upstreamMode:"container-ip"}')"

"$dim_bin" external-url ingress add http \
  --name "$ingress" \
  --description "Local HTTP development URL" \
  --scheme http \
  --argument "$argument"
