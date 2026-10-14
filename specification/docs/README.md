# Documentation

Start with:

1. [Overview](overview.md)
2. [Configuration](configuration.md)
3. [Native Project and workspace lifecycle](project-workspaces.md)
4. [Global native CI](ci-runners.md)
5. [Adoption and cutover](adoption.md)
6. [Architecture](architecture.md)

The normative contracts are indexed in [`../specs/README.md`](../specs/README.md).

DIM's runtime is native-only. Forge-specific contribution helpers are outside
the product boundary. Documents not linked above describe predecessor designs
or development history and are not active operator journeys.

## Glossary

- **Project**: one native identity rooted in one protected reviewed Git ref.
- **Workspace**: persistent agent execution with a protected-root snapshot and
  workspace-scoped proposal authority.
- **Ordinary job**: candidate-controlled bounded Sysbox execution.
- **QEMU job**: candidate-controlled bounded real-KVM guest execution.
- **Ready**: native Project/workspace prerequisites are live; CI is not implied.
- **Promotion**: human-approved checked compare-and-swap of the protected ref.
