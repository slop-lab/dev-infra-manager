# Verification

## Scope

This specification defines the minimum verification gates for development.

## Source Check Gate

`just check` must run:

1. TypeScript check.
2. Unit tests.
3. Production build.

Current commands:

```bash
just typecheck
just test
just build
```

This gate must require only Node.js and pnpm, not Docker, a runtime backend,
QEMU, KVM, or an installed DIM CLI.

`just verify-plugin-install` builds the publishable packages and verifies
plugin installation through their packaged shape. It is separate because it
tests an installation workflow rather than source correctness.

The external URL plugin unit suite must exercise real HTTP forwarding through
each configured reverse-proxy shape and provider URL generation. A configured
Tailnet can additionally run:

```bash
scripts/tailscale-external-url-smoke.sh
```

That smoke starts a workspace service, provisions a Tailscale URL through the
controller API, fetches a unique sentinel through the external URL, and revokes
the route. It is required verification code but is not part of the static gate
because it depends on operator-owned Tailnet DNS and TLS.

## Container Integration Gate

`just verify-container` requires Docker with Compose v2 and support for
privileged nested containers. It covers workspace image builds, nested Docker,
lifecycle behavior, and packed CLI project workflows. It may run against the
nested Docker daemon in a development container and must not claim to verify a
host runtime backend boundary.

## Container Backend Gates

`scripts/container-cgroup-smoke.bash` requires direct access to the target Docker
host and must cover exact runc cgroup v2 CPU, memory, swap, and PID limits,
including live resource updates.

`scripts/container-sysbox-isolation-smoke.bash` requires a prebuilt workspace
image and direct access to a Docker host with `sysbox-runc`. It must cover:

- Sysbox workspace-root execution with explicit outer CPU, memory, and PID
  limits.
- Exact cgroup v2 limit visibility inside the workspace root.
- Nested Docker `hello-world` execution.
- Bidirectional image-store isolation using unique host-only and inner-only
  probe tags, independent of pre-existing image caches.

The independent multi-repository example gate verifies managed Git, protected
refs, and controller deployment of a secret-bearing child beside an isolated
agent container. It must also prove the agent container uses a distinct Docker
daemon, cannot list the controller's secret-bearing child, and does not receive
the child's raw secret environment.

## Fast Isolation Gate

`just isolation-check` must run without contacting Docker or creating a
container. It verifies generated runtime arguments, including:

- Outer CPU, memory, and PID limits.
- Job-specific workspace and nested runtime data mounts.
- Absence of the host `/var/lib/docker` as a mount source.
- Absence of the host `/var/run/docker.sock`.

`just isolation-check-json` runs the same tests with Vitest's JSON reporter so
CI can consume a single JSON document from stdout. These static checks do not
replace `scripts/container-sysbox-isolation-smoke.bash`, which verifies actual
Sysbox and cgroup behavior.

## Backend Verification

Runtime backend verification should include:

- `doctor` for the installed backend.
- Workspace create, task execution, stop/start persistence, and discard.
- Nested container smoke when the backend claims nested Docker or Podman support.

Current verified host evidence:

- Rootless Podman can create a workspace on a compatible host.
- gVisor can pass `doctor` when recorded as the installed backend.
- gVisor can create a workspace and run nested Docker.
- gVisor inner Docker can run nested `hello-world`.
- Sysbox inner Docker can run nested `hello-world` without access to the host
  Docker image store.
- Sysbox exposes the outer agent CPU, memory, and PID cgroup limits to the
  nested workload as aggregate upper bounds.

## Install Verification

Host installation scripts must be verified by:

- Checksum verification for downloaded runtime artifacts.
- Runtime version command after installation.
- Docker runtime registration check when the script registers a runtime.

`scripts/kvm-host-install-smoke.bash BACKEND` verifies one backend installer in
a disposable VM. `just verify-environments-kvm` requires QEMU and writable
`/dev/kvm` and runs the gate for every backend in a separate VM.

## Installer Facade Verification

`just verify-mise-install-smoke` requires Docker and network access. It
verifies `mise use -g 'npm:@slop-lab/install-dim@<version>'` end to end in a
disposable container against a local npm registry seeded from freshly built
tarballs, covering facade-only vs. proxied `--help`/`--version`, the
mise-detected `--no-local-bin` default, and an explicit `--local-bin`
override. See [Installer Facade](14-installer-facade.md).

`just verify-example-external-urls` requires Docker. It proves
`examples/external-urls/README.md` end to end: a host DIM controller,
host-configured profile, dnsmasq wildcard DNS, a project-root workspace,
the nested `dev` Compose service, a further `deep` container, root relay,
reverse proxy, profile discovery, URL creation, HTTP access, and revocation.

`just verify-example-multi-repo-project` requires Docker and managed Gitea. It
materializes the three repository skeletons under
`examples/multi-repo-project/repos/` in a temporary directory and verifies the
documented project, protected refs, workspace, nested Docker, repository
access, and secret-bearing service boundary.

## Documentation Verification

When behavior changes:

- Update affected feature specs.
- Update local-details if command shapes, file formats, image entrypoints, or script behavior change.
- Update `docs/status.md` with new verified evidence.
- Ensure examples do not contradict protected-ref or secret-boundary invariants.
