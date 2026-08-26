# Core development changelog

## Unreleased

- Add a volume-preserving host shutdown/start lifecycle that leaves the
  controller available, records previously ready workspaces, CI runners, and
  plugin-managed host containers, restores infrastructure before execution
  runtimes, and reports maintenance readiness until every target recovers.

- Give reviewed Project Compose runtimes a stable workspace-local identity
  independent of the outer DIM workspace name, and reconcile a stale `ready`
  phase to `stopped` when the managed outer container is no longer running.

- Remove the pre-stable gVisor, rootless-Podman, and privileged-runc workspace
  backends. Sysbox is now the sole workspace backend; ordinary runc remains an
  internal runtime for trusted infrastructure, obsolete configuration and
  state are rejected, and KVM is no longer a Sysbox doctor prerequisite.

- Resolve util-linux `script`'s own descriptor to a validated `/dev/pts/N`
  device and resize that device directly, avoiding Sysbox's non-effective
  ioctl forwarding through `/proc/<pid>/fd/*` while preserving ordered delivery.

- Keep real PTY creation and I/O coverage in the explicitly identified Sysbox
  host-mode CI lane while leaving the window-resize assertion to supported
  hosts and disposable Ubuntu QEMU lanes. Treat the missing resize as an
  observation of the current CI environment pending investigation, rather
  than a documented Sysbox limitation or something inferred from an optional
  `/proc/sysbox` marker.

- Materialize reviewed workspace host aliases such as the resolved DIM Gitea
  control-network address in `/etc/hosts`, avoiding runtime-specific embedded
  DNS behavior while retaining the recorded endpoint boundary.

- Materialize the DIM-owned registry cache's inspected control-network address
  in workspace `/etc/hosts`, so gVisor workspaces use the host-governed mirror
  without depending on runsc's nested embedded-DNS behavior.

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
