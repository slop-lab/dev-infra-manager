# DIM External URLs Plugin

This local-build DIM plugin adds `/api/urls` routes to the general DIM
controller and implements a shared route registry with direct HTTP and Caddy
HTTPS ingress modes. Caddy is built into this plugin; DNS credentials remain
in provider-specific packages. See
[`docs/external-urls.md`](../../../docs/external-urls.md) for the controller,
deployment, DNS, tunnel, and workspace API contracts.
