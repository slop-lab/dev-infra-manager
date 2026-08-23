# Verification

## Scope

This specification defines the minimum verification gates for development.

## Example runner

`scripts/verify-example.bash` is the common entrypoint for runnable examples.
It accepts `current-installed` and `{sysbox,gvisor,rootless-podman,runc}`
backends. A named backend provisions an independent disposable QEMU guest for
each selected example, while an optional example selector narrows the
otherwise compatible suite. Its dirty-repository policy is `auto`, `use`, or
`discard`: `auto`
rejects dirty input, `use` snapshots tracked and non-ignored untracked files,
and `discard` verifies committed `HEAD` without changing the checkout.

Repository-backed examples use `repos/<alias>`. The common fixture code must
initialize every alias as an independent Git repository, update matching
entries in the root `repos.yml`, and register that reviewed set in the
verification run's disposable managed Gitea.

The QEMU wrapper owns only guest and toolchain provisioning. After installing
the selected backend, Node.js, pnpm, and `just`, it must invoke repository
verification through `just install` and `just verify example`.

`project-runtime-cgroups` is one leaf feature example. Its systemd, cgroupfs,
and unsupported variants are files within that leaf and the common example
runner must dispatch its contract smoke for both direct selection and the
compatible `all` suite. Because the contract smoke is backend-independent, a
named backend may run it without provisioning a dedicated QEMU guest.

## Source Check Gate

`just check` must run:

1. TypeScript check.
2. Unit tests.
3. Production build.

Current commands:

```bash
just typecheck
just test
just build-packages
```

This gate must require only Node.js and pnpm, not Docker, a runtime backend,
QEMU, KVM, or an installed DIM CLI.

CI runner unit coverage must verify resource-default precedence, stable managed
names, and that default container arguments use the configured isolation
runtime without mounting the host Docker socket. It must also verify that the
host-scoped pull-through cache has no published port and that Sysbox and QEMU
runner daemon configuration selects only the internal cache endpoints. The
managed CI journey must also verify that its test-only relay reaches nested KVM
guest and DinD image pulls without embedding the cache in Project examples.

Managed Git verification must distinguish the host maintainer from the
workspace writer and verify that protected-ref push options allowlist only the
maintainer while force pushes remain disabled.

The Sysbox lane of `scripts/kvm-host-install-smoke.bash` must enable a real
Project CI runner inside its disposable QEMU guest and inspect the effective
Docker runtime, CPU quota, memory limit, PID limit, non-privileged flag, and
absence of a host Docker-socket mount. It must then run the CI runner feature
smoke against a non-root repository.

`just verify example sysbox DIRTY ci-runner` must register one
organization-scoped runner
for a multi-repository Project, open a pull request in a non-root repository,
and wait for that repository's real workflow to succeed.

`just verify plugin-install` builds the publishable packages and verifies
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

## Managed Workspace Integration Gate

`just ci workspace` requires Docker with Compose v2 and support for privileged
nested containers. It runs source checks plus workspace image, nested Docker,
lifecycle, packed-project, shared-upstream, and cgroup verification. The
broader `just verify container` additionally covers the canonical self Project.
These recipes may run against the nested Docker daemon in a development
container and must not claim to verify a host runtime backend boundary.

Gitea runs this gate automatically via the managed
`dim-container-integration` host-mode capability from `.gitea/workflows`; its
controller sockets and nested Docker bind mounts must share one filesystem
namespace. The managed runner's Sysbox boundary does not support another
user-namespace mapping inside its inner Docker, so this automatic lane excludes
the canonical self-Project's rootless-DinD sidecar. The runc QEMU gate retains
that verification on a compatible clean host. GitHub automatic CI is
intentionally limited to Node.js type checks and tests that need no APT packages
or container runtime. Sysbox and KVM host-backend gates also remain available
through the manually dispatched GitHub workflows.

The automatic managed-workspace gate must also run the shared-upstream example smoke.
That smoke proves that two logical DIM repositories can share one external Git
upstream while fetch and push map only the branches and tags owned by each
repository namespace.

The multi-repository container smoke MUST dirty both a tracked file and a
non-ignored untracked file before requesting a workspace restart. It MUST
verify rejection without a container stop, Project-service replacement, Git
state change, workspace-record change, or setup invocation, then clean the
checkout and exercise the successful fast-forward restart path.

The stateful development-flow smoke MUST materialize
`examples/projects/full-development-flow` and exercise one continuous journey:
profiled resource-bounded creation, private nested Docker, dirty restart
rejection, a reviewed root update, stop/start persistence, controller socket
replacement, setup-error recovery, agent-home backup, discard, recreation,
restore, and final managed-state/resource cleanup. Failure hooks and managed CI
cache configuration MUST be injected only into its temporary repositories;
the checked-in example remains a normal user-facing Project. The release gate
MUST execute this journey in the clean runc KVM guest, where unprivileged user
namespace mappings required by its private rootless DinD are supported; a
doubly nested generic Actions job container is not an equivalent environment.

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

The multi-repository Project example gate verifies managed Git, protected refs, and
trusted deployment of a reviewed secret-bearing child beside a Project-owned
agent. It must use the example's generated `repos.yml`, prove the agent uses a
distinct Docker daemon, cannot list the trusted workspace's secret-bearing
child, does not mount either Docker socket, and does not receive the child's
raw secret environment. Its shared bind-mount probe must work when the agent
UID differs from the rootless-DinD UID.
The single- and multi-repository example gates must also verify that their
fresh rootless-DinD images retain executable UID/GID mapping helpers with a
setuid fallback before exercising the private daemon.
The canonical self-Project gate must verify the same helper fallback and
healthy private daemon both after workspace creation and after the first
workspace restart, proving the fallback survives the persistent nested image
store and workspace-container lifecycle. It MUST also inspect the DIM-owned
workspace engine and verify that it selects the managed pull-through cache
without adding cache configuration to the Project definition. Canonical setup must explicitly
rebuild both Project images so an updated DinD entrypoint can repair an
existing workspace whose cached sidecar image can no longer start. The root
entrypoint MUST initialize the volume-mounted Docker data directory and
`XDG_RUNTIME_DIR` for the rootless UID after mounts are applied, and the gate
MUST verify their ownership and private runtime-directory mode. It MUST repair
the existing data tree once under a versioned marker so cached root-owned
containerd state is recovered without recursively changing a large image store
on every sidecar restart. It MUST additionally validate creation of
`containerd/daemon` as the rootless UID and repeat the repair if a partial
prior start added an inaccessible descendant after the marker was written.

Project-runtime cgroup verification MUST cover both supported delegation
shapes (`systemd` and `cgroupfs`) and the unsupported `none` driver. The
checked-in feature examples MUST consume the same versioned Project manifest
contract and helper used by Project setup, and the negative example MUST fail
closed rather than silently running without resource enforcement.

## Fast Isolation Gate

`just verify isolation` must run without contacting Docker or creating a
container. It verifies generated runtime arguments, including:

- Outer CPU, memory, and PID limits.
- Job-specific workspace and nested runtime data mounts.
- Absence of the host `/var/lib/docker` as a mount source.
- Absence of the host `/var/run/docker.sock`.

`just verify isolation-json` runs the same tests with Vitest's JSON reporter so
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

`scripts/kvm-host-install-smoke.bash BACKEND` and
`just verify environments-kvm BACKEND` verify one backend installer in a
disposable VM. Omitting `BACKEND` runs every backend in a separate VM. Managed
development CI MUST schedule each backend as an independent `dim-qemu` job so
available host capacities can run them concurrently without exposing capacity
names in tracked workflow code. These expensive jobs MUST run automatically
only for non-draft pull requests whose base is the managed development
repository's `main` promotion branch. Routine pull requests into `development`
retain source and managed-workspace verification without reserving
disposable-QEMU release capacity.
The runc guest must additionally run `just verify self-development` after the
host installer completes. This verifies the canonical DIM Project, its
unprivileged agent and private rootless-DinD sidecar, and the path-scoped
RootlessKit AppArmor profile together on a clean Ubuntu host. The guest
verification user must use UID 1001 so this gate does not accidentally depend
on matching the rootless-DinD image's UID 1000.
The Sysbox guest must additionally verify a privileged trusted workspace using
its directly passed `/dev/kvm` with QEMU, absence of Sysbox registration in
the workspace's Project daemon, and a separate unprivileged Sysbox isolation
probe running a private DinD workload.

## Installer Facade Verification

`just verify mise-install-smoke` requires Docker and network access. It
verifies `mise use --raw --global 'npm:@slop-lab/dim-installer@<version>'` end to end in a
disposable container against a local npm registry seeded from freshly built
tarballs, covering facade-only vs. proxied `--help`/`--version`, the
mise-detected `--no-local-bin` default, and an explicit `--local-bin`
override. See [Installer Facade](14-installer-facade.md).
Package tests must additionally cover the published launcher's direct use of
Node.js 24 or 26, its `mise exec node@24` fallback when the available Node.js
is absent or unsupported, npm `.bin` symlink resolution, argv preservation,
and its actionable failure when neither runtime path is available.

`just verify example BACKEND DIRTY external-urls` requires Docker. It proves
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

`just verify example BACKEND DIRTY multi-repository` requires Docker and managed Gitea. It
materializes the repositories under `examples/projects/multi-repository/repos/` in a temporary
directory and verifies the manifest-aware `project create --url
--apply-repos` flow,
protected refs, workspace, Project-owned agent, host Git identity, managed
repository access, nested Docker, and secret-bearing service boundary.

`just verify example BACKEND DIRTY single-repository` verifies the default
one-repository shape under `examples/projects/single-repository/`: no
`.dim/repos.yml`, no protected ref or secret service, a direct agent-style
push to `main`, explicit workspace resource limits, and an unprivileged
Project-owned agent serving the application through its private rootless DinD
sidecar boundary. It must also prove that the agent receives a filtered
controller proxy with only bodyless self-restart permission, cannot reach host
inputs, and can request an asynchronous restart of its own workspace. The
smoke accepts `DIM_EXAMPLE_WORK_ROOT` so a remote or sibling DinD daemon can
resolve controller-socket bind sources through a shared absolute path.

`just verify example BACKEND DIRTY full-development-flow` verifies the
multi-repository reference Project and the complete stateful journey described
above. CI runner lifecycle remains separate because it is a Project-external
host capability rather than Project-owned development configuration.

## Documentation Verification

When behavior changes:

- Update affected feature specs.
- Update local-details if command shapes, file formats, image entrypoints, or script behavior change.
- Update `docs/status.md` with new verified evidence.
- Ensure examples do not contradict protected-ref or secret-boundary invariants.
