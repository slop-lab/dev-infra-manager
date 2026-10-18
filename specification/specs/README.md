# Specification index

The base product is an ordinary Git workspace on a local or SSH-selected host.
Managed Git, review and CI are optional integrations. The architecture is being
reworked according to the [implementation plan](../docs/architecture-rework-plan.md).

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

The configuration, capability matrix and native verification documents numbered
03, 04 and 12 describe the optional managed integration. They do not impose a
native Project, CI or controller on base workspaces. Managed-specific lifecycle,
CLI and trust details live under `core/packages/managed/docs/`. Historical
decisions and candidate VM profiles are design context, not stable contracts.
