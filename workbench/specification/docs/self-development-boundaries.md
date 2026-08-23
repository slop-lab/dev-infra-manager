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
| `specification` | User documentation, normative contracts, and accepted design rationale | Reviewed contract changes without implementation or host authority |
| one repository per plugin | One independently selected and installed provider implementation | Reviewed only when that plugin is selected |

Concrete plugin names should describe the capability or implementation, such
as `managed-git-gitea`, `external-urls`, and `dns-cloudflare`; they do not repeat
the Project name.

The first extraction target is `root`. The current Git history now stages each
future repository in a physical subtree governed by
`repository-boundaries.json`; the final `core` repository must build without
`development`, `root`, or an unselected plugin. Repository separation, rather
than a generated allowlist from a larger monorepo, will make that review
closure directly visible as a Git revision.

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

A transitional agent checkout is:

```text
/workspace/
├── .dim/                 root bootstrap; not the agent cwd
└── workbench/            agent cwd and future `development` root
    ├── core/
    ├── specification/
    └── plugins/
    ├── managed-git-gitea/
    ├── external-urls/
    └── dns-cloudflare/
```

This remains a Project-owned layout rather than a stable DIM core contract.
Before physical repository extraction, the named subtrees share one Git
checkout; afterward each checkout retains its own commit, branch, pull request,
dependency lock, build, and release boundary while development materializes
the same integrated shape.

## Migration order

1. Publish actual Project repositories in the runtime manifest and document
   that code visibility is separate from promotion and execution authority.
2. Keep the reviewed outer self-development lifecycle reduced to the current
   private-runtime bootstrap, with the agent owned by that runtime.
3. Keep every tracked path assigned to its staged future repository, then
   extract the minimal `root` repository without ordinary development tooling.
4. Make the prospective `core` source independently buildable, then extract it
   without a dual monorepo compatibility layer.
5. Extract provider implementations by independently installed plugin and move
   cross-repository examples and release gates to `development`.
