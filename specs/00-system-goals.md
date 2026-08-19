# System Goals

## Purpose

`dev-infra-manager` provides a host-side execution and trust layer for
persistent AI-assisted development workspaces, separate verification, and
review-gated promotion into protected or secret-bearing state.

The system must let an untrusted agent:

- Execute commands in a persistent workspace that is removed only when
  explicitly discarded.
- Read and write files in that workspace.
- Run nested container workloads through an approved runtime backend.
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
- Protected Git refs must reject direct push through managed Gitea policy.
- Managed pull request merge is the path that updates protected refs in normal operation.
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
