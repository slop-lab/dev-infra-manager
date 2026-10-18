# Documentation

Start with [usage](usage.md) for ordinary local or remote development.

| Guide | Scope |
| --- | --- |
| [Overview](overview.md) | Product and responsibility summary |
| [Usage](usage.md) | Install, create, resume and select a host |
| [Configuration](configuration.md) | Base settings and optional integration settings |
| [Workspace images](runtime-images.md) | Build and select the matching image |
| [Resource isolation](resource-isolation.md) | Limits, persistence and runtime observations |
| [Architecture](architecture.md) | Package and execution ownership |
| [Rework plan](architecture-rework-plan.md) | Implementation sequence and backed-up issues |
| [Adoption](adoption.md) | Data preservation across incompatible versions |

Optional managed capabilities have their own [package guide](../../core/packages/managed/README.md),
[Project lifecycle](project-workspaces.md), [CI](ci-runners.md),
[plugins](plugins.md) and [External URLs](external-urls.md). They do not turn a
control plane or a managed Project into a prerequisite for development.

The [specification index](../specs/README.md) distinguishes base contracts from
optional integration policies. Only the installer facade has a preserved
compatibility boundary; historical decisions are design context.
