# Core development changelog

## Unreleased

- Select Docker's bundled legacy iptables implementation for gVisor workspaces
  so their nested daemon does not require the unsupported nftables protocol.

- Updated the managed Sysbox CI runner to checksum-pinned Node.js 24 and a
  pinned `just` so host-mode actions and DIM's integration recipes use the
  supported toolchain directly.

- Added protected-root-owned QEMU cache hooks, digest-keyed shared runner
  bases, and coverage for disposable-job isolation from persistent cache
  state.

- Command-session tests now cover base64-framed stdout/stderr, including bytes
  that are invalid UTF-8, so streaming `run`/`exec` remains safe for binary
  backup and restore tasks.

- Added coverage for exact-name workspace capability providers, required
  fail-closed behavior, recommended availability reporting, and validated
  provider additions to workspace container arguments.

- Interactive controller command sessions now use a real Linux PTY and track
  terminal resize events, while internal lifecycle probe output stays out of
  the user-visible task stream.

- New managed Gitea repositories enable the built-in issue tracker only for
  the Project root, keeping Project work tracking in one repository without
  changing repositories that already exist.
