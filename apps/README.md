# Applications

Deployable processes belong under `apps/`.

There are currently no deployable application packages. The executable DIM
CLI lives under `packages/dim-cli`; its reusable implementation lives under
`packages/core`.

Planned application boundaries:

- `entry-api`: optional agent-facing API for requesting managed ingress.
- `edge-controller`: optional route reconciler for reverse proxies and tunnel
  providers.

Applications may depend on packages under `packages/`, but must not import
another application's private source files.
