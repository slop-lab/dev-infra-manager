# Packages

Reusable contracts and provider adapters belong under `packages/`.

Planned package boundaries:

- Git-host contracts independent of Gitea, Forgejo, or the built-in bare Git
  implementation.
- A Gitea provider adapter added as an optional package.
- Entry and edge-route contracts independent of Caddy, Cloudflare Tunnel, or
  Tailscale.
- Provider adapters that translate those contracts for a specific external
  system.

Packages must not start daemons or mutate host state merely by being imported.
Credentials stay in application/runtime configuration and must not be embedded
in shared contracts.
