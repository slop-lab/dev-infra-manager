# DIM External URLs Plugin

This local-build DIM plugin adds `/api/urls` routes to the general DIM
controller and implements a shared route registry with direct HTTP and Caddy
HTTPS ingress modes. Caddy is built into this plugin; DNS credentials remain
in separately installed provider plugins registered through the External URL
driver contract. The controller automatically reconciles Caddy ingress DNS,
generated runtime files, and containers; no project-owned deployment or
separate setup command is required. See
[`docs/external-urls.md`](../../../docs/external-urls.md) for the controller,
deployment, DNS, tunnel, and workspace API contracts.
