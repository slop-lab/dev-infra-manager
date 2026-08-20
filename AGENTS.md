# Project Guidance

## Project overview

`dev-infra-manager` (DIM) provides Linux host infrastructure for persistent,
isolated, review-gated AI development workspaces. It manages Project-scoped
Git repositories, protected refs, workspace lifecycle, nested container
backends, constrained controller capabilities, and optional isolated CI
runners.

The coding agent and containers it starts are untrusted. DIM owns the boundary
around them; it does not own agent reasoning, project-specific development
environments, product code, or general orchestration policy.

## Goals

- Let agents work persistently, run nested containers, and push proposed
  changes without exposing host control sockets or raw runtime secrets.
- Keep protected refs and secret-bearing environments behind human review.
- Let each Project define its repositories, development containers, tasks, and
  agent process through reviewed repository code.
- Keep workspace runtime, resource, Git, plugin, and CI execution boundaries
  explicit and independently configurable where practical.
- Provide reproducible host, container, and disposable-QEMU verification for
  supported environments.

Changes to secret access, trusted/untrusted boundaries, protected refs,
runtime-backend assumptions, resource enforcement, or deployment authority
require especially careful review against `specs/`.

## Pull requests

For pull-request creation, updates, or CI monitoring, use the repository-local
`pull-request` skill. Resolve the forge with its helper before invoking
provider-specific tools; do not assume that `origin` is GitHub.

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
