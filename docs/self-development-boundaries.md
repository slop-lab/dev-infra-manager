# DIM Self-development Boundaries

DIM's own Project is intended to demonstrate the same separation expected of
security-sensitive users: agents may read and propose changes to all source,
while reviewed refs and narrow capabilities control what may affect trusted
runtimes or the host.

## Target repositories

Repository names omit a redundant `dim-` prefix because they are already
scoped by the DIM Project or canonical organization:

| Repository | Responsibility | Review boundary |
| --- | --- | --- |
| `root` | Minimal reviewed `.dim` bootstrap, capability grants, promotion policy, and pinned host deployment inputs | Human review before trusted lifecycle or host authority changes |
| `core` | Self-contained source required to build DIM's controller, CLI, public contracts, and installer | Independently buildable and reviewable by a DIM user |
| `development` | Common agent development stack and contributor orchestration | Agent-changeable; not part of a production build review closure |
| `core-development` | Core tests, fixtures, and test-only tooling | Exercises `core` without becoming part of its build closure |
| one `*-development` repository per plugin | Tests and test-only tooling for the paired plugin | Exercises the plugin without becoming part of its build closure |
| `verification` | Cross-component, container, host, KVM, and release-gate checks | May consume all source repositories but is not a production input |
| `examples` | Reviewed, runnable Project examples | Demonstrates Project contracts independently of the verification harness |
| `specification` | User documentation, normative contracts, and accepted design rationale | Reviewed contract changes without implementation or host authority |
| one repository per plugin | One independently selected and installed provider implementation | Reviewed only when that plugin is selected |

Concrete plugin names should describe the capability or implementation, such
as `managed-git-gitea`, `external-urls`, and `dns-cloudflare`; they do not repeat
the Project name.

Each repository has its own managed `main`, Git history, and review closure:
`core` builds without `development`, `root`, or an unselected plugin, while
paired development and verification repositories consume those production
sources as siblings.

## Agent-owned development environment

The reviewed outer workspace bootstraps only a private nested container
runtime and constrained controller capabilities. The agent itself, its tools,
and ordinary development services run as containers inside that private
runtime from source currently held in this repository and ultimately owned by
`development`.

This lets an agent rebuild and restart its development environment without
turning those definitions into trusted outer lifecycle code. It does not grant
the inner environment the outer Project-runtime socket, host Docker socket,
raw secrets, `/dev/kvm`, controller replacement, or host installation
authority. Those remain explicit reviewed capabilities.

All Project repositories may be visible to the agent so it can prepare changes
to security-sensitive code. Visibility does not grant direct protected-branch
push, merge, deployment, secret access, or host execution.

## Integrated development tree

DIM supplies the read-only runtime repository catalog and scoped Git
credentials. The `root` bootstrap or the inner `development` environment may
clone catalog entries into any useful layout and synthesize pnpm, TypeScript,
or `just` orchestration across them. DIM core does not define that layout.

The self-development checkout is:

```text
/workspace/                     agent cwd and `development` checkout
├── project/                    reviewed `root` bootstrap
├── core/
├── specification/
├── core-development/          core tests and test-only dependencies
├── plugin-*/                  minimal plugin build inputs
├── plugin-*-development/      paired plugin tests
├── examples/                  Project examples
└── verification/              cross-repository and host checks
```

This remains a Project-owned layout rather than a stable DIM core contract.
The reviewed root `.dim/repos.yml` registers every alias and its external
import and publish mappings. Setup reads only the actual runtime catalog,
clones missing ready aliases into the fixed layout above, and never invokes
Git against an existing agent-controlled checkout. Agents fetch, fast-forward,
switch, or preserve dirty/proposal work through their own inner-runtime Git
process. Each checkout has its own origin, branch, pull request, dependency
lock, build, and publish boundary while retaining the same development
ergonomics.

The repository split is complete. Further provider extraction or canonical
repository publication is ordinary follow-up work and must not reintroduce a
dual monorepo layout.
