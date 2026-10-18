# Project Guidance

## Project overview

`dev-infra-manager` (DIM) provides persistent development workspaces on local
or SSH-selected Linux hosts. The base product creates an isolated workspace
from an ordinary Git repository and owns its lifecycle, data and runtime
resources. Managed Git, review, CI and the host controller are optional
integrations owned by `core/packages/managed` and related packages.

The coding agent and containers it starts are untrusted. DIM owns their host
boundary; it does not own agent reasoning, project-specific tools or product
code. The CLI owns presentation and transport. Workspace application logic and
runtime adapters execute on the selected host without a required daemon.

## Goals

- Make ordinary local and remote development comfortable without requiring a
  managed Project, control plane or repository-specific lifecycle definition.
- Preserve checkout, home and nested-container data across sessions and
  container recreation; discard only exact owned resources explicitly.
- Keep host control sockets, host files and operator credentials outside the
  agent container. Use practical runtime containment without claiming a strong
  hostile-tenant security boundary.
- Keep transport, runtime, source acquisition, state and optional services
  independent. Repository workflow interpretation belongs to its integration.
- Where managed Git or secret-bearing services are selected, keep protected
  refs, promotion authority and raw service credentials behind their explicit
  trusted boundaries.
- Verify important behavior with meaningful tests and disposable runtime
  checks, rather than preserving obsolete contracts through fixture volume.

Changes to host access, data ownership, optional secret access, protected refs,
resource enforcement or deployment authority require careful review against
`specification/specs/` and the owning managed package's design documents.

## Pull requests

For pull-request creation, updates, or CI monitoring, use the repository-local
`pull-request` skill. Resolve the forge with its helper before invoking
provider-specific tools; do not assume that `origin` is GitHub.

## Work tracking and repository ownership

- Record DIM-managed Gitea issues only in the Project `root` repository. Pull
  requests may reference the root issue in their body.
- This root repository is the canonical monorepo. Production package source is
  under `core/` and `plugin-*/`; centralized package and plugin tests are under
  `tests/`; cross-component checks are under `verification/`; and Project-level
  normative contracts are under `specification/`.
- Put package-specific changelogs, maintenance notes, and design documents with
  their owning production package or package group. Keep the core package-group
  changelog at `core/CHANGELOG.md`; keep a plugin changelog in that plugin's
  root. Keep cross-package release outcomes in the root `CHANGELOG.md`.
- Keep test implementation and test-only fixtures in `tests/`, even when their
  package changelog or design contract lives with production source.

## Changelogs

- Write changelog entries for user-visible release outcomes, not individual
  implementation, test, documentation, or refactoring commits.
- Keep one evolving entry for an outcome within an unreleased version. Fold
  fixes and refinements into that entry instead of documenting intermediate
  defects that users never received.
- Add a separate fix entry when the affected behavior was already released.
- Follow the normative policy in `specification/docs/releasing.md` and the
  repository ownership rules above.

## Pre-stable compatibility

DIM has not had a stable release. Current releases are pre-stable `0.x`
versions, and backward compatibility is not a project requirement yet.

- Do not preserve old CLI, API, configuration, state, or internal extension
  contracts solely for backward compatibility.
- Prefer a clear final contract over compatibility aliases, deprecation
  shims, dual formats, or migrations.
- Breaking changes must still be intentional and internally consistent:
  update implementation, tests, examples, specifications, package READMEs,
  changelog, and other affected documentation together.
- Do not silently accept obsolete input when rejecting it gives users a safer
  and clearer failure.
- Add migration or compatibility behavior only when a task explicitly
  requires it or when preserving user data is part of the stated design.

Exact version pinning and full review remain required because DIM executes
reviewed Project code and manages security-sensitive host infrastructure.
