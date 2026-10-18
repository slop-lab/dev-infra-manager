# Root monorepo

DIM is developed, tested and built from one root repository. The source commit
identifies the full package/plugin/test tree; separately packed packages retain
that shared source identity. There is no required sibling checkout.

| Path | Responsibility |
| --- | --- |
| `core/packages/core` | Base workspace application, state, runtime/source primitives |
| `core/packages/cli` | Commands, presentation, host contexts and SSH transport |
| `core/packages/managed` | Optional Project/source attachment, controller and execution composition |
| `core/packages/native-git` | Optional repository, proposal, review and protected-ref authority |
| `core/packages/installer` | Exact component installation, activation and recovery behind the facade |
| `plugin-*/` | Explicitly selected integrations and workflow language |
| `tests/` | Centralized behavior tests and fixtures |
| `verification/` | Disposable cross-component, packaging and physical runtime checks |
| `specification/` | Current architecture, usage and design records |
| `.dim/` | DIM-recognized Project configuration (`repos.yml`, `ci/runner.yml`) |
| `scripts/`, `agent/` | Explicit repository development tools and CI job payloads |
| `verification/qemu/` | Explicit host-run QEMU verification tools |

The base dependency graph is CLI → workspace core. Managed code is loaded only
when its operation/source is selected. A workflow plugin compiles configuration
into a neutral plan; repository authority does not interpret that language.
Service plugins use the managed plugin host and shared contracts. Shared
contracts do not import concrete adapters, and one package does not depend on
another package's private source layout.

Installation selects the transitive closure of requested components from a
matched bundle. The existence of an optional artifact does not activate it.
The installer facade remains the supported installation boundary; internal
package exports and storage protocols can change together during development.

The same one-container workspace develops DIM and other repositories. Coding
agent tools and repository tasks are workspace user code. There is no required
trusted outer lifecycle, rootless sidecar daemon or automatic host hook.
See [self-development boundaries](self-development-boundaries.md).

Optional managed review and CI operate on exact candidate bytes. Protected-ref
promotion, host installation, public tags and package publication have distinct
roles. Internal test evidence does not publish or approve the candidate.
