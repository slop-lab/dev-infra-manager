# Managed CI runners

DIM workspaces are the persistent development environment. Managed CI runners
repeat pull-request checks in separate checkouts and isolated execution
environments so their result can be used as independent review evidence. The
Project-scoped Sysbox runner remains managed until it is disabled. On capable
hosts, release gates instead use a fresh outer QEMU VM for every job.

Enable only the executors that a Project needs:

```bash
dim ci runner enable example sysbox
dim ci runner enable example qemu
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
run `dim ci runner enable PROJECT sysbox` once to replace the stored runner
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

When explicitly enabled on a host with KVM, DIM starts a small trusted runc
supervisor with `/dev/kvm`. A Gitea `workflow_job` webhook asks it to boot a
QEMU VM only after a queued job selects the `dim-qemu` label. Workflow code
runs inside that VM and sees its nested
KVM device; it never runs in the supervisor or receives the DIM host's device
directly. Each registration accepts one job and the VM overlay is deleted after
shutdown. While idle, no guest exists; only the small webhook process remains.
The container limit still leaves room for its QEMU child while a job runs.
Gitea registration is
only the current coordinator adapter, so replacing the built-in coordinator
does not change this executor boundary.

Enabling a QEMU executor adds only its managed supervisor hostname to Gitea's
webhook allowlist and restarts the managed Gitea service to apply that setting.
DIM does not enable unrestricted private-network webhook delivery.

The DIM repository selects this label for the KVM release gate on non-draft
pull requests in its managed development host. Draft pull requests and branch
pushes skip the expensive gate. The job runs `just ci kvm`, matching the KVM
backend-installer verification required for a release. After installing a DIM
version that adds or changes runner labels, re-enable the runner once:

```bash
dim ci runner enable dim qemu
dim ci runner status dim
```

The status must include a ready `executors.qemu` record with `dim-qemu` and a
supervisor name. Enabling detects host KVM, while successful VM readiness also
requires nested virtualization from the host KVM module. `dim ci runner logs
dim sysbox` follows the normal Sysbox runner;
use `dim ci runner logs dim qemu` when diagnosing VM boot,
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
dim ci runner enable example sysbox --cpus 8 --memory 16GiB --pids-limit 4096
```

`restart` and re-enabling without flags preserve an existing Project override.
Disable and enable again without flags to return to inherited defaults.

The QEMU supervisor container is capped at 6 CPUs, 14 GiB, and 1024 PIDs so
its QEMU child can receive 6 vCPUs and 12 GiB during a selected job. These are
limits, not reservations; while idle there is no VM or guest memory. Each job
uses a disposable 64 GiB overlay.

The QEMU host-install smoke verifies the Sysbox limits in a clean
Ubuntu guest rather than relying on a development workspace's delegated
cgroup hierarchy.

## Lifecycle

```bash
dim ci runner list
dim ci runner logs example sysbox
dim ci runner stop example sysbox
dim ci runner restart example sysbox
dim ci runner disable example sysbox --yes
```

The coordinator integration is provider-specific, but runner state, lifecycle,
and executor capabilities are provider-neutral. Managed Gitea Actions is the
initial adapter. `dim-qemu` is an executor capability that any Project workflow
may select; the disposable VM boundary and label do not encode DIM's particular
release policy or depend on Gitea-specific execution behavior.

The executor argument is required for lifecycle operations, so managing one
executor never starts, replaces, or deletes the other. As a pre-stable state
contract, the earlier combined runner record is not migrated automatically;
remove it before upgrading or clean up its managed resources manually.
