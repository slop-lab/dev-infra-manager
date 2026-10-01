#!/usr/bin/env bash
set -euo pipefail

dim_bin="${DIM_BIN:-dim}"
domain="${DIM_EXTERNAL_URL_DOMAIN:?set DIM_EXTERNAL_URL_DOMAIN to the reviewed wildcard domain}"
listen_host="${DIM_EXTERNAL_URL_LISTEN_HOST:-0.0.0.0}"
listen_port="${DIM_EXTERNAL_URL_LISTEN_PORT:-443}"
dns_zone="${DIM_EXTERNAL_URL_DNS_ZONE:?set DIM_EXTERNAL_URL_DNS_ZONE to the authoritative zone}"
dns_value="${DIM_EXTERNAL_URL_DNS_VALUE:?set DIM_EXTERNAL_URL_DNS_VALUE to the host address or name}"
: "${CF_API_TOKEN:?set CF_API_TOKEN to a zone-scoped Cloudflare API token}"

dns_argument="$(jq -cn \
  --arg zone "$dns_zone" \
  --arg value "$dns_value" \
  '{zone:$zone,value:$value,proxied:false}')"

"$dim_bin" external-url dns-provider add cloudflare \
  --name web-cloudflare \
  --credential "$CF_API_TOKEN"

set -- external-url ingress add caddy \
  --name https-ts \
  --description "Authenticated coding-agent Web URL" \
  --scheme https \
  --domain "$domain" \
  --listen-host "$listen_host" \
  --listen-port "$listen_port" \
  --dns-provider web-cloudflare \
  --dns-argument "$dns_argument"
if [[ -n "${DIM_EXTERNAL_URL_ACME_EMAIL:-}" ]]; then
  set -- "$@" --acme-email "$DIM_EXTERNAL_URL_ACME_EMAIL"
fi
"$dim_bin" "$@"

"$dim_bin" external-url ingress verify https-ts
