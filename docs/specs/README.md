# Specification index

The base product is an ordinary Git workspace on a local or SSH-selected host.
Repository hosting, code review, merge policy, Git-CI and webhook delivery are
independently selected control-plane plugins. Human review does not require CI
or a compiler. Host core owns lifecycle and generic controller capabilities; host plugins
add features, while control-plane plugins own shared authority and coordination.

| Document | Scope |
| --- | --- |
| [System goals](00-system-goals.md) | Base product outcomes |
| [Threat model](01-threat-model.md) | Practical development isolation |
| [Boundaries](02-boundaries-and-trust.md) | Client, host and agent ownership |
| [Runtime](05-runtime-backends.md) | Supported container runtime and future adapters |
| [CLI](10-cli-contract.md) | Default development commands |
| [Doctor](11-doctor-checks.md) | Base host inspection |
| [Lifecycle](13-repo-workspace-lifecycle.md) | Workspace data and runtime transitions |
| [Installer](14-installer-facade.md) | Preserved installer facade |

[Configuration](03-configuration.md), [authority responsibilities](04-trust-lifecycle-capability-matrix.md)
and [verification](12-verification.md) cover the shared architecture and optional
integrations. Owner-specific details live with `packages/host/plugins/` and
`packages/control-plane/plugins/`. See [plugin scopes](../guides/plugin-scopes.md)
for runtime SDK boundaries and installation roles. [Git transport and feature authority](local-details/native-git-transport.md) defines policy ownership and durable CAS recovery.
