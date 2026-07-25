# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Renamed the `@slop-lab/install-dim` executable from `install-dim` to
  `dim`, and its subcommands from `cli`/`plugin` to `install-cli`/
  `install-plugin`, so both `mise use -g npm:@slop-lab/install-dim` and
  `mise use -g npm:@slop-lab/dim-cli` resolve to the same command name.
- Made the installer a strict facade: it owns only `installer`,
  `install-cli`, and `install-plugin`, and proxies every other command
  (including `dim plugin`, a `dim-cli` command) unchanged to a separately
  installed `@slop-lab/dim-cli`, adding `DIM_INVOKED_VIA_INSTALLER`/
  `DIM_INSTALLER_VERSION` for display purposes only. See
  [Installer Facade](specs/14-installer-facade.md).
- Added `--no-local-bin`/`--local-bin` install modes with a mise-aware
  default, a managed `~/.local/bin/dim` symlink that refuses to touch an
  unmanaged or pre-0.2 `dim`, and a combined `dim --version` line once a
  CLI is configured.

### Added

- [Example: A Multi-repository Project](examples/multi-repo-project/README.md),
  a copyable example project with a tested, real-container walkthrough.

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
- Made the Project root ref optional with repository `HEAD` fallback, added
  per-workspace CPU/memory/PID limits, and scoped JSON output to
  record-producing subcommands.
- Added `dim git setup`, Project-specific Git base URLs, and a smaller runtime
  manifest that leaves repository layout and nested containers to `.dim`.
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
