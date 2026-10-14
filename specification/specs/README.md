# Specification index

DIM's current product contract is root-only and native-only.

| Document | Kind | Scope |
| --- | --- | --- |
| [System goals](00-system-goals.md) | Intent | Product outcomes |
| [Threat model](01-threat-model.md) | Intent | Assets and adversaries |
| [Trust boundaries](02-boundaries-and-trust.md) | Contract | Authority isolation |
| [Configuration](03-configuration.md) | Contract | Native selection, runtime, CI, cutover |
| [Capability matrix](04-trust-lifecycle-capability-matrix.md) | Contract | Lifecycle and authority transitions |
| [Runtime backends](05-runtime-backends.md) | Profile | Current Sysbox backend |
| [CLI](10-cli-contract.md) | Contract | Root-only public commands |
| [Doctor](11-doctor-checks.md) | Verification | Host diagnostics |
| [Verification](12-verification.md) | Verification | Native gates and evidence classes |
| [Lifecycle](13-repo-workspace-lifecycle.md) | Contract | Root and workspace state |
| [Installer](14-installer-facade.md) | Contract | Native service installation |

Historical decision records and local details explain implementation evolution.
They do not restore removed provider, repository CRUD, Project purge, or
Project-scoped runner APIs.
