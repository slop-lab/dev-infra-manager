# DIM Self-development Boundaries

DIM's own Project demonstrates the same separation expected of
security-sensitive users. Agents may read and propose changes to the complete
root monorepo, while reviewed refs and narrow capabilities control what may
affect trusted runtimes, protected state, publication, or the host.

## Root Tree Responsibilities

| Path | Responsibility | Review boundary |
| --- | --- | --- |
| `.dim/` | Reviewed self-Project bootstrap, capability grants, task dispatch, and lifecycle | Human review before trusted lifecycle or host authority changes |
| `core/` | Production core, CLI, controller, contracts, native Git, installer packages, package design records, and core group changelog | Exact production and package ownership within the root tree |
| `plugin-*/` | Independently selected production plugins and plugin changelogs | Reviewed when that plugin or its host capability is selected |
| `tests/` | Centralized core and plugin tests, fixtures, and test-only tooling | Candidate-controlled evidence, not production or promotion authority |
| `verification/` | Cross-component, container, host, Sysbox, QEMU, and release-gate checks | May consume the complete tree but is not a package runtime input |
| `examples/` | Reviewed, runnable Project examples | Demonstrates Project contracts without granting host authority |
| `specification/` | User documentation, normative contracts, accepted design rationale, and operator designs | Contract review without runtime or publication authority |
| `agent/` and root tooling | Common development environment and contributor orchestration | Agent-changeable candidate input, not trusted merely because it is tooling |

The root commit binds all these paths into one candidate. Directory ownership
keeps build inputs, tests, verification, and policy reviewable, but it doesn't
create independent Git histories or release identities. Production packages can
still be built and packed separately from the same exact tree.

## Agent-owned Development Environment

The reviewed outer workspace bootstraps only a private nested container runtime
and constrained controller capabilities. The agent, its tools, and ordinary
development services run inside that private runtime from the root checkout.

This lets an agent rebuild and restart its development environment without
turning those definitions into trusted outer lifecycle code. It does not grant
the inner environment the outer Project-runtime socket, host Docker socket, raw
secrets, `/dev/kvm`, controller replacement, public publication, or host
installation authority. Those remain explicit reviewed capabilities.

The complete repository may be visible and writable to the agent so it can
prepare changes to security-sensitive code. Visibility does not grant direct
protected-ref push, merge, deployment, secret access, release, or host
execution.

## Integrated Checkout

The self-development checkout is the root monorepo itself:

```text
/workspace/                     agent cwd and canonical root checkout
├── .dim/                       reviewed outer lifecycle
├── core/                       production core packages
├── plugin-*/                   production plugins
├── tests/                      centralized tests and fixtures
├── specification/              docs and normative contracts
├── examples/                   Project examples
└── verification/               cross-component and host gates
```

DIM core does not prescribe this layout for other Projects. For the self-Project,
the root `.dim` contract stages the one reviewed checkout and never performs Git
operations against an existing agent-controlled checkout. Agents fetch, switch,
and preserve dirty or proposal work through their own inner-runtime Git process.

## Review And Publication

DIM-managed Gitea hosts internal proposals, review, and automatic CI. GitHub
publication, signed tags, package publication, and releases remain separate
trusted maintainer actions. Both sides identify the same exact root commit and
tree, but internal approval does not confer public credentials or release
authority.

Ordinary test results remain candidate-controlled when the candidate supplies
their scripts or configuration. The separate Sysbox and QEMU gates retain their
documented runtime boundaries. Human approval of the complete tree and checked
promotion remain required regardless of green CI.
