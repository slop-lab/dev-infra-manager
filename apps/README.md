# Applications

Deployable processes belong under `apps/`.

Current applications:

- `manager`: host-side CLI and controller for jobs, managed Git primitives,
  runtime deployment, and readiness checks.

Planned application boundaries:

- `entry-api`: optional agent-facing API for requesting managed ingress.
- `edge-controller`: optional route reconciler for reverse proxies and tunnel
  providers.

Applications may depend on packages under `packages/`, but must not import
another application's private source files.
