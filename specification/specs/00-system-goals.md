# System Goals

## Purpose

`dev-infra-manager` provides persistent, comfortable development workspaces
for coding agents on Linux. A workspace keeps its checkout and installed tools
across sessions, supports services and nested container workloads, and lets an
agent resume work without rebuilding the development environment for every
session.

Developer convenience and review-gated isolation are co-equal goals. DIM must
support fast iteration and reproducible development while keeping host control
sockets, raw Project secrets, protected refs, and trusted operations outside
the agent's authority.

The system must let an untrusted agent:

- Execute commands in a persistent workspace that is removed only when
  explicitly discarded.
- Read and write files in that workspace.
- Retain Project-approved development tools and configuration across workspace
  stop and start cycles.
- Run nested container workloads through an approved runtime backend.
- Repeat Project-defined development tasks from reviewed repository code.
- Request reproducible verification in a separate checkout outside mutable
  workspace state.
- Push proposed changes to a managed Git host.
- Request reviewed changes to be promoted through a managed pull request flow.
- Keep code that can affect secret-bearing environments in separate,
  Project-selected repositories with stricter review policy when appropriate.

The system must prevent that agent from:

- Receiving raw secret material.
- Reading or writing secret-bearing runtime files directly.
- Updating approved Git refs through direct push.
- Controlling secret-bearing containers directly.
- Using the host Docker socket as its nested container mechanism.

## Global Invariants

- Agent containers inside workspace roots are untrusted.
- Nested containers created by agents are untrusted.
- Secret-bearing containers are trusted only when built and deployed from reviewed source.
- Raw product/runtime secrets must never be injected into agent
  containers. A constrained infrastructure capability such as the internal
  Gitea writer credential may be injected when its server-side permissions
  cannot modify protected refs or secret-bearing runtime state.
- Secret-bearing runtime deployment must use the configured approved Git ref.
- Protected Git refs must reject ordinary direct pushes, force pushes,
  deletion, and every other unreviewed direct update through managed Git
  policy. Only the host-side checked promotion operation in
  `TRUST-PROMOTION-001` and
  `TRUST-PROMOTION-CAS-001` may atomically update the expected old object ID to
  the exact reviewed candidate.
- Managed pull request promotion through that checked compare-and-swap
  operation is the only normal path that updates protected refs.
- Runtime backend selection and storage backend selection must be independent.
- `directory` storage does not enforce `diskBytes` and must be treated as a compatibility backend.
- `doctor` must check the workspace runtime backend recorded during host installation.
- Workspaces persist until explicitly discarded.

## Non-Goals

The project does not own:

- Agent reasoning.
- Agent runtime process implementation.
- MCP or other tool protocol details.
- Internet access policy.
- Human collaboration UI.
- Automatic provider-specific GitHub synchronization.
- Model request audit logs.
- Project-specific product code.

## Future Direction

General development tool setup and configuration that works independently of a
Project is a future plugin direction. The current product requires each
reviewed Project to define its development container, tasks, agent process, and
tool setup. Existing plugin APIs provide named extensions and constrained host
capabilities, but they do not yet provide this general tool-management layer.

## Compatibility Goals

DIM has no stable release. Backward compatibility across pre-stable `0.x`
versions is not required. Contract changes should prefer a clear final design
over aliases, shims, dual formats, or implicit migrations, while updating the
implementation, tests, examples, specifications, and documentation together.

## Review Scope

Changes that affect these topics are global changes:

- Secret access.
- Trusted/untrusted boundary.
- Protected ref behavior.
- Runtime backend trust assumptions.
- Storage quota enforcement.
- Trusted Project lifecycle deployment authority.
- Config compatibility.
