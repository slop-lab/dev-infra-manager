# System Goals

## Purpose

`dev-infra-manager` provides host-side infrastructure for persistent AI-assisted development workspaces in isolated, review-gated environments.

The system must let an untrusted agent:

- Execute commands in an ephemeral workspace.
- Read and write files in that workspace.
- Run nested container workloads through an approved runtime backend.
- Push proposed changes to a managed Git host.
- Request reviewed changes to be promoted through a managed pull request flow.

The system must prevent that agent from:

- Receiving raw secret material.
- Reading or writing secret-bearing runtime files directly.
- Updating approved Git refs through direct push.
- Controlling secret-bearing containers directly.
- Using the host Docker socket as its nested container mechanism.

## Global Invariants

- Agent workspace containers are untrusted.
- Nested containers created by agents are untrusted.
- Secret-bearing containers are trusted only when built and deployed from reviewed source.
- Raw product/runtime secrets must never be injected into agent workspace
  containers. A constrained infrastructure capability such as the internal
  Gitea writer credential may be injected when its server-side permissions
  cannot modify protected refs or secret-bearing runtime state.
- Secret-bearing runtime deployment must use the configured approved Git ref.
- Protected Git refs must reject direct push through managed bare repository hooks.
- Managed pull request merge is the path that updates protected refs in normal operation.
- Runtime backend selection and storage backend selection must be independent.
- `directory` storage does not enforce `diskBytes` and must be treated as a compatibility backend.
- `doctor --backend` must check the selected workspace runtime backend.
- Workspaces persist until explicitly discarded.
- The controller is trusted because it controls secret-bearing deployment.

## Non-Goals

The project does not own:

- Agent reasoning.
- Agent runtime process implementation.
- MCP or other tool protocol details.
- Internet access policy.
- Human collaboration UI.
- GitHub synchronization.
- Model request audit logs.
- Project-specific product code.

## Compatibility Goals

- CLI commands should remain stable unless a specification update explicitly changes their contract.

## Review Scope

Changes that affect these topics are global changes:

- Secret access.
- Trusted/untrusted boundary.
- Protected ref behavior.
- Runtime backend trust assumptions.
- Storage quota enforcement.
- Controller deployment authority.
- Config compatibility.
