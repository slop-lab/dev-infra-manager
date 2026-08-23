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
| `development` | Agent development stack, examples, integration tests, QEMU gates, and contributor orchestration | Agent-changeable; not part of the core build review closure |
| one repository per plugin | One independently selected and installed provider implementation | Reviewed only when that plugin is selected |

Concrete plugin names should describe the capability or implementation, such
as `managed-git-gitea`, `external-urls`, and `dns-cloudflare`; they do not repeat
the Project name.

The first extraction target is `root`. The current monorepo may remain intact
until `core` can move without compatibility scaffolding, but the final `core`
repository must build without `development`, `root`, or an unselected plugin.
Repository separation, rather than a generated allowlist from a larger
monorepo, makes that review closure directly visible as a Git revision.

## Agent-owned development environment

The reviewed outer workspace must eventually bootstrap only a private nested
container runtime and constrained controller capabilities. The agent itself,
its tools, and ordinary development services then run as containers inside
that private runtime from source owned by `development`.

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

A typical agent view may be:

```text
/workspace/repos/
├── root/
├── core/
├── development/
└── plugins/
    ├── managed-git-gitea/
    ├── external-urls/
    └── dns-cloudflare/
```

This is an explanatory Project-owned layout, not a stable DIM path contract.
Each checkout retains its own commit, branch, pull request, dependency lock,
build, and release boundary.

## Migration order

1. Publish actual Project repositories in the runtime manifest and document
   that code visibility is separate from promotion and execution authority.
2. Reduce the reviewed outer self-development lifecycle to a private-runtime
   bootstrap and move the agent into that runtime.
3. Extract the minimal `root` repository and continuously verify that it does
   not contain ordinary development tooling.
4. Make the prospective `core` source independently buildable, then extract it
   without a dual monorepo compatibility layer.
5. Extract provider implementations by independently installed plugin and move
   cross-repository examples and release gates to `development`.
