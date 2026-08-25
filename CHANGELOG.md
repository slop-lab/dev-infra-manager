# Core development changelog

## Unreleased

- Resolve util-linux `script`'s own descriptor to a validated `/dev/pts/N`
  device and resize that device directly, avoiding Sysbox's non-effective
  ioctl forwarding through `/proc/<pid>/fd/*` while preserving ordered delivery.

- Keep real PTY creation and I/O coverage in the Sysbox host-mode CI lane while
  leaving the window-resize assertion to supported hosts and disposable Ubuntu
  QEMU lanes, because Sysbox does not apply sibling-process PTY resize ioctls.

- Materialize reviewed workspace host aliases such as the resolved DIM Gitea
  control-network address in `/etc/hosts`, avoiding runtime-specific embedded
  DNS behavior while retaining the recorded endpoint boundary.

- Completed the rootless-Podman workspace toolchain with supported Node.js,
  `just`, Docker-compatible Podman Compose, and the controller proxy used by
  reviewed Project setup scripts.

- Disabled nested Docker's iptables and ip6tables rule programming for gVisor
  workspaces because runsc exposes neither nftables nor legacy NAT tables;
  release integration still verifies the resulting Project networking path.

- Updated the managed Sysbox CI runner to checksum-pinned Node.js 24 and a
  pinned `just` so host-mode actions and DIM's integration recipes use the
  supported toolchain directly.

- Included `jq` and `socat` in the managed Sysbox CI runner for Project
  repository materialization and the root-owned registry-cache relay during
  full host-mode integration checks.

- Included only util-linux-misc's `script` PTY helper in the managed Sysbox CI
  runner so interactive command sessions use a real terminal while Sysbox
  startup retains Alpine's BusyBox `mount` implementation.

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
