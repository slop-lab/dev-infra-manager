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
- Renamed the unprivileged account used by workspace-root images from `agent`
  to `dim` (`/home/agent` → `/home/dim`, `AGENT_UID`/`AGENT_GID` build args
  → `DIM_UID`/`DIM_GID`). The account belongs to DIM's controller/root
  environment; an actual coding agent runs in a separate child container.
  See [Trust Boundaries](specs/02-boundaries-and-trust.md#agent-container-boundary).
- `rootless-podman` no longer defaults its outer container to
  `--privileged`; it now receives the specific capabilities nested
  unprivileged user namespaces need instead (the same set already used for
  `gvisor`). Set `DIM_WORKSPACE_PRIVILEGED=true` to restore the old
  behavior if a host needs it. **This has not been verified against a real
  rootless-podman host** — it could not be exercised in this change's own
  development environment, whose own nested sandboxing already rejects
  nested user-namespace creation even under full `--privileged`, for
  reasons unrelated to this change. Validate with `just
  verify-host-backend-kvm rootless-podman` (now exercises the same
  capability set) and `DIM_WORKSPACE_BACKEND=rootless-podman bash
  scripts/container-lifecycle-smoke.bash` before relying on it.

- Split the root `README.md` into user-facing content (installing and using
  `dim`) and [CONTRIBUTING.md](CONTRIBUTING.md) (building/verifying DIM
  itself), added a project glossary
  ([docs/README.md](docs/README.md#glossary)) covering Project/Workspace
  scope and what "controller" actually refers to, and added `just cli` to
  build core and run `dim` from source without the
  `ERR_MODULE_NOT_FOUND`-if-core-isn't-built footgun of invoking `tsx`
  directly.

### Added

- [Multi-repository project
  example](examples/multi-repo-project/README.md), with independent
  real-container verification of its materialized repository skeletons.
- [External URL example](examples/external-urls/README.md), a copyable,
  dnsmasq-verified walkthrough covering a nested development container and a
  container inside it.
- Added plugin API v2 with an instance-scoped DIM controller route registry
  and ordered disposal.
- Added authenticated external URL routes on the general DIM controller and a
  local-build plugin with a shared reverse proxy plus Tailscale and Cloudflare
  hostname providers. Public profiles expose only a name, description, and
  external HTTP protocol; host-only bindings keep proxy/provider details
  private.

### Fixed

- Every documented walkthrough (root README, `docs/repo-workspaces.md`,
  `docs/project-workspaces.md`, `docs/usage.md`, `packages/dim-cli/README.md`,
  the multi-repository example) showed `dim repo create ... --root` without
  `--protect`, then a bare `dim repo protect`. `--protect` only exists on
  `repo create`/`repo import`; omitting it there left `repo protect` with
  nothing to apply, and it reported success anyway — every literal reading
  of the docs left the root branch completely unprotected. All of them now
  show `--protect` at `create` time; the container workspace smoke test verifies
  a protected root actually rejects a direct push.

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
