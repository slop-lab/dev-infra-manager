# Managed CI runners

DIM workspaces are the persistent development environment. Managed CI runners
repeat pull-request checks in separate checkouts and isolated execution
environments so their result can be used as independent review evidence. The
Project-scoped Sysbox runner remains managed until it is disabled. On capable
hosts, release gates instead use a fresh outer QEMU VM for every job.

Enable the runner set for a Project:

```bash
dim ci runner enable example
dim ci runner status example
```

The initial Gitea coordinator registers it at the Project's managed
organization. Every root or non-root repository registered to that Project can
therefore select the same runner.

Workflows select it with the stable DIM label:

```yaml
jobs:
  verify:
    runs-on: dim
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm workspace:check
      - run: pnpm workspace:test
```

For compatibility with workflows shared with GitHub, the initial adapter also
maps `ubuntu-24.04` to the same job image.

The `dim-container-integration` label runs directly in the isolated runner
container (Gitea runner "host" mode). It is reserved for the repository's
Gitea container-integration workflow, whose controller sockets and nested Docker
bind mounts must share one filesystem namespace. Other workflow jobs remain
in disposable job containers. After upgrading DIM across a label change,
run `dim ci runner enable PROJECT` once to replace the stored runner
registration and publish the new labels.

As described in the
[development repository model](development-repositories.md), DIM develops
itself primarily through its active managed Git host while GitHub remains the
canonical public source. The current automatic workflows are provider-specific:
`.gitea/workflows/ci.yml`
uses that host-mode label for the container gate supported within Sysbox. It
excludes the canonical self-Project's rootless-DinD sidecar because Sysbox does
not support another user-namespace mapping inside its inner Docker; the runc
QEMU gate covers that boundary on a compatible clean host. `.github/workflows/ci.yml`
intentionally runs only lightweight Node.js type checks and tests without APT
or Docker setup. GitHub-only manual Sysbox and KVM release workflows remain
under `.github/workflows` and are not copied into the managed development Gitea
instance.

When host KVM is available, DIM starts a separate trusted runc supervisor with
`/dev/kvm`. It maintains one waiting QEMU VM registered with the
`dim-release-gate` label. Workflow code runs inside that VM and sees its nested
KVM device; it never runs in the supervisor or receives the DIM host's device
directly. Each registration accepts one job, the VM overlay is deleted after
shutdown, and a fresh VM is prepared for the next job. Gitea registration is
only the current coordinator adapter, so replacing the built-in coordinator
does not change this executor boundary.

The DIM repository selects this label for the KVM release gate on non-draft
pull requests in its managed development host. Draft pull requests and branch
pushes skip the expensive gate. The job runs `just ci kvm`, matching the KVM
backend-installer verification required for a release. After installing a DIM
version that adds or changes runner labels, re-enable the runner once:

```bash
dim ci runner enable dim
dim ci runner status dim
```

The status must report `kvm: true`, include `dim-release-gate`, and name the
QEMU supervisor; otherwise the host did not expose `/dev/kvm` when the runner
set was reconciled. This detects host KVM, while successful VM readiness also
requires nested virtualization from the host KVM module. `dim ci runner logs
dim` follows the normal Sysbox runner;
use `dim ci runner logs dim --release-gate` when diagnosing VM boot,
registration, or replacement.

The Sysbox runner has concurrency one. Its nested daemon, disposable job
containers, registration data, and resource limits live outside workspace
state. It does not mount the host Docker socket or receive DIM workspace
credentials. The default outer isolation runtime is `sysbox-runc`; the inner
daemon is rootful but cannot escape that system-container boundary. Override
`DIM_CI_RUNNER_RUNTIME` only with another runtime that can safely support the
nested daemon.

## Resources

The Sysbox runner fallback is 4 CPUs, 8 GiB of memory, and 2048 PIDs. Installation
defaults can be changed:

```bash
dim ci runner defaults set --cpus 6 --memory 12GiB --pids-limit 4096
```

A Project can override them:

```bash
dim ci runner enable example --cpus 8 --memory 16GiB --pids-limit 4096
```

`restart` and re-enabling without flags preserve an existing Project override.
Disable and enable again without flags to return to inherited defaults.

The QEMU supervisor is separately capped at 6 CPUs, 14 GiB, and 1024 PIDs;
each VM receives 6 vCPUs, 12 GiB, and a disposable 64 GiB overlay. These fixed
release-gate resources leave room for its nested backend VMs.

The QEMU host-install smoke verifies the Sysbox limits in a clean
Ubuntu guest rather than relying on a development workspace's delegated
cgroup hierarchy.

## Lifecycle

```bash
dim ci runner list
dim ci runner logs example
dim ci runner stop example
dim ci runner restart example
dim ci runner disable example --yes
```

The coordinator integration is provider-specific, but runner state, lifecycle,
and executor capabilities are provider-neutral. Managed Gitea Actions is the
initial adapter; the disposable VM boundary does not depend on Gitea-specific
execution behavior.
