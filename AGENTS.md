# Project Guidance

## Project overview

`dev-infra-manager` (DIM) provides persistent development workspaces on local
or SSH-selected Linux hosts. The base product creates an isolated workspace
from an ordinary Git repository and owns its lifecycle, data and runtime
resources. The host core owns the generic controller; Native Git, review, CI and shared
services belong to explicit host and control-plane plugins.

The coding agent and containers it starts are untrusted. DIM owns their host
boundary; it does not own agent reasoning, project-specific tools or product
code. The CLI owns host selection and transport; the selected host owns command
parsing, help and presentation. Workspace application logic and runtime adapters
execute on that host without a required daemon.

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
`docs/specs/` and the owning package's design documents.

## Pull requests

For pull-request creation, updates, or CI monitoring, use the repository-local
`pull-request` skill. Resolve the forge with its helper before invoking
provider-specific tools; do not assume that `origin` is GitHub.

## Work tracking and repository ownership

- Track current issues and pull requests in the canonical GitHub repository.
  Imported issue numbers identify historical backup records; they do not
  select a live forge or an issue destination.
- This root repository is the canonical monorepo. Production packages live in
  `packages/{host,control-plane}/{core,plugins}` and `packages/contracts`, with
  CLI, installer and web packages alongside them. See
  `docs/guides/repository-layout.md` for ownership and dependency boundaries.
- Keep all tests and test-only fixtures in the single `tests/` workspace;
  cross-component and privileged fixtures live in `tests/scenarios/`.
  Shared runners belong in `scripts/checks/`, package helpers in
  `scripts/packages/`, and normative contracts in `docs/specs/`.
- Write repository tools and tests in TypeScript. Standalone Node tools use
  erasable types and run directly on the supported Node 24/26 toolchain. Keep
  JavaScript for browser/guest assets delivered without compilation and for
  bootstrap code that runs before that toolchain is selected. Remaining JS
  sources require `// @ts-check` and the shared strict compiler check.
- Keep package design notes with their owner. Record current release outcomes
  in the root `CHANGELOG.md`; old package-group notes are archived in
  `docs/history/`. Nonpublishable workspaces use the `@this-project/` namespace.
- Keep test implementation and test-only fixtures in `tests/`, even when their
  package changelog or design contract lives with production source.

## Changelogs

- Write changelog entries for user-visible release outcomes, not individual
  implementation, test, documentation, or refactoring commits.
- Keep one evolving entry for an outcome within an unreleased version. Fold
  fixes and refinements into that entry instead of documenting intermediate
  defects that users never received.
- Add a separate fix entry when the affected behavior was already released.
- Follow the normative policy in `docs/guides/releasing.md` and the
  repository ownership rules above.

## Pre-stable compatibility

DIM has not had a stable release. Current releases are pre-stable `0.x`
versions. Retain the published `@slop-lab/dim-installer` facade and the small
versioned CLI–host wire contract in `docs/specs/cli-host-protocol-v1.md`.
Other backward compatibility is not a requirement. Package release versions do
not determine CLI–host wire compatibility; preserve the frozen version-1 fixtures.

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
