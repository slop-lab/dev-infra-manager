# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-24

### Changed

- Added first-class projects with project-scoped managed Gitea organizations
  and repository aliases.
- Replaced bare-repository registration with empty repository creation,
  optional import, host/workspace URL lookup, and optional Git credential
  wrapping.
- Made workspaces reference a project root repository and ref, with project
  changes applied on explicit update, start, or restart rather than while a
  workspace is running.
- Replaced the namespaced workspace CLI with concise top-level lifecycle
  commands and hierarchical Commander help.
- Removed automatic migration of 0.1 workspace state.

## [0.1.0] - 2026-07-24

### Added

- Provider-neutral DIM core APIs and a thin `dim` command-line package.
- Persistent Gitea-backed project workspaces with nested container support.
- Per-workspace Sysbox, gVisor, rootless Podman, and privileged-runc backend selection.
- Review-gated Git and secret-runtime deployment workflows.
- Versioned plugin API and standalone plugin installer.
- Container, lifecycle, multi-repository, packaging, and self-project smoke tests.

[Unreleased]: https://github.com/slop-lab/dev-infra-manager/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/slop-lab/dev-infra-manager/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/slop-lab/dev-infra-manager/releases/tag/v0.1.0
