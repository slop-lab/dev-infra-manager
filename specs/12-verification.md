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

CI runner unit coverage must verify resource-default precedence, stable managed
names, and that default container arguments use the configured isolation
runtime without mounting the host Docker socket.

The Sysbox lane of `scripts/kvm-host-install-smoke.bash` must enable a real
Project CI runner inside its disposable QEMU guest and inspect the effective
Docker runtime, CPU quota, memory limit, PID limit, non-privileged flag, and
absence of a host Docker-socket mount.

`just verify-plugin-install` builds the publishable packages and verifies
plugin installation through their packaged shape. It is separate because it
tests an installation workflow rather than source correctness.

The external URL plugin unit suite must exercise real HTTP forwarding through
configured listeners sharing the hostname registry, generated URL shape,
concurrent automatic-name allocation, default workspace-prefix rejection,
webhook approval and response bounds, forwarded-header normalization, and
independent route claim revocation. The Cloudflare plugin suite must verify named driver
registration, provider/record argument normalization, and DNS reconciliation.
The route-policy test launches the checked-in advanced example server rather
than maintaining a test-only webhook implementation.
A configured Tailnet
ingress can additionally run:

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

- Sysbox system-container execution with explicit CPU, memory, and PID limits.
- Exact cgroup v2 limit visibility inside the container.
- Nested Docker `hello-world` execution.
- Bidirectional image-store isolation using unique host-only and inner-only
  probe tags, independent of pre-existing image caches.

The canonical Project example gate verifies managed Git, protected refs, and
trusted deployment of a reviewed secret-bearing child beside a Project-owned
agent. It must use the example's generated `repos.yml`, prove the agent uses a
distinct Docker daemon, cannot list the trusted workspace's secret-bearing
child, does not mount either Docker socket, and does not receive the child's
raw secret environment.

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
The Sysbox guest must additionally verify a privileged trusted workspace using
its directly passed `/dev/kvm` with QEMU, absence of Sysbox registration in
the workspace's Project daemon, and an unprivileged host-side Sysbox isolation
probe running a private DinD workload.

## Installer Facade Verification

`just verify-mise-install-smoke` requires Docker and network access. It
verifies `mise use -g 'npm:@slop-lab/dim-installer@<version>'` end to end in a
disposable container against a local npm registry seeded from freshly built
tarballs, covering facade-only vs. proxied `--help`/`--version`, the
mise-detected `--no-local-bin` default, and an explicit `--local-bin`
override. See [Installer Facade](14-installer-facade.md).

`just verify-example-external-urls` requires Docker. It proves
`examples/features/external-urls/README.md` end to end: a host DIM controller,
plugin loading before any external URL config exists, the example's checked-in
ingress and URL scripts, dnsmasq wildcard DNS, a project-root workspace,
the nested `dev` Compose service, a further `deep` container, root relay,
reverse proxy, ingress discovery, URL creation, HTTP access, and revocation.
The HTTP client runs on a separate Docker network, a loopback-only listener
must be unreachable from it, unknown and revoked routes must return 404, and
the controller-managed Caddy deployment must be generated and running without
an explicit setup command. Its private router port must not appear in the user
configuration.
It also reconciles an ingress through a local Cloudflare-compatible API,
resolves the resulting wildcard through authoritative CoreDNS, and verifies
provider cleanup without external credentials.
Ingress discovery, creation, and revocation must run through the public
`dim external-url` CLI rather than project-specific curl wrappers.

`just verify-example-project` requires Docker and managed Gitea. It
materializes the repositories under `examples/project/repos/` in a temporary
directory and verifies the documented `project create --repos` flow,
protected refs, workspace, Project-owned agent, host Git identity, managed
repository access, nested Docker, and secret-bearing service boundary.

## Documentation Verification

When behavior changes:

- Update affected feature specs.
- Update local-details if command shapes, file formats, image entrypoints, or script behavior change.
- Update `docs/status.md` with new verified evidence.
- Ensure examples do not contradict protected-ref or secret-boundary invariants.
