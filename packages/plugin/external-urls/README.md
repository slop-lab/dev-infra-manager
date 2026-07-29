# DIM External URLs Plugin

This local-build DIM plugin adds `/api/urls` routes to the general DIM
controller and implements provider-agnostic named HTTP and HTTPS ingresses.
DNS and TLS infrastructure such as Cloudflare and Caddy remains outside the
system plugin. See
[`docs/external-urls.md`](../../../docs/external-urls.md) for the controller,
deployment, DNS, tunnel, and workspace API contracts.
