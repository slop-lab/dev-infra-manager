# Managed CI runners

DIM workspaces are the persistent development environment. Managed CI runners
repeat pull-request checks in separate checkouts and isolated execution
environments so their result can be used as independent review evidence. Each
named Project-scoped runner remains managed until it is deleted. On capable
hosts, release gates may instead use a fresh outer QEMU VM for every job.

Enable only the named runners that a Project needs. Names are stable local
identities; multiple Sysbox runners provide parallel capacity:

```bash
dim ci runner create example primary sysbox
dim ci runner create example secondary sysbox
dim ci runner create example release qemu
dim ci runner status example primary
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
Gitea managed-workspace integration workflow, whose controller sockets and nested Docker
bind mounts must share one filesystem namespace. Other workflow jobs remain
in disposable job containers. After upgrading DIM across a label change,
run `dim ci runner restart PROJECT RUNNER` once to replace the stored runner
registration and publish the new labels.

The managed Sysbox runner host image includes Node.js because JavaScript
actions such as `actions/checkout` execute before a workflow can run
`actions/setup-node`. DIM builds that image from a digest-pinned act-runner
base during runner creation or restart. `just verify sysbox-ci-runner-image`
builds and probes the same generated image without installing DIM on the host.
The host-mode integration lane probes Sysbox mount mediation and the inner
Docker daemon both before and after the integration command. A failed probe
terminates PID 1 after reporting the job failure; the runner container's
`unless-stopped` policy then starts it with a fresh Sysbox namespace instead
of allowing mount failures to cascade into unrelated jobs.

DIM starts one host-scoped CNCF Distribution registry as an anonymous Docker
Hub pull-through cache when the first managed CI runner is reconciled. Sysbox
runner daemons use it directly on the private `dim-control` network. Each QEMU
supervisor exposes only a local TCP relay to its disposable guest, whose Docker
daemon uses the relay at `10.0.2.2:5000`. DIM's CI harness extends that relay
across each additional test-only NAT boundary, so a nested KVM guest and DinD
daemon use the same cache without adding cache configuration to Project
examples. The supervisor verifies the relay before booting a guest; an
unavailable cache is reported as a runner error instead of silently sending
the guest directly to Docker Hub. The registry has no published host
port, accepts no pushes in proxy mode, stores no Docker Hub credentials, and
is not attached to Project workspace networks. Its managed filesystem volume
is shared across Projects and runner executors, so common public layers survive
runner and VM disposal. A cache miss still reaches Docker Hub and remains
subject to its upstream policy; pin frequently used images by digest where
practical.

After upgrading an existing installation to a DIM version that introduces or
changes this cache configuration, run `dim ci runner restart PROJECT RUNNER`
once for each existing Sysbox runner. QEMU supervisor image-version changes are
reconciled automatically, but an explicit restart is also safe when immediate
replacement is preferred.

As described in the
[development repository model](development-repositories.md), DIM develops
itself primarily through its active managed Git host while GitHub remains the
canonical public source. The current automatic workflows are provider-specific:
`.gitea/workflows/ci.yml`
uses that host-mode label for the container gate supported within Sysbox. It
excludes the canonical self-Project's private nested runtime; the runc
QEMU gate covers that boundary on a compatible clean host. `.github/workflows/ci.yml`
intentionally runs only lightweight Node.js type checks and tests without APT
or Docker setup. GitHub-only manual Sysbox and KVM release workflows remain
under `.github/workflows` and are not copied into the managed development Gitea
instance.

When explicitly created on a host with KVM, DIM starts a small trusted runc
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

All QEMU supervisors in a Project form a shared scheduler, with one concurrent
capacity per named runner. They persist demand and renewable capacity claims in
a shared dispatch volume before acknowledging webhooks. Duplicate deliveries
remain idempotent, and an atomically claimed job boots on only one capacity. A
VM exit does not itself consume queued demand:
the scheduler waits for Gitea to report that a job started or completed, and
starts another disposable VM with bounded retry delay while demand remains.
This matters because an organization runner cannot bind its next fetch to the
job ID that caused the webhook and may receive another coordinator task.
Persisted queued demand resumes after a supervisor restart, so webhook
redelivery is not required.

The first QEMU job for a Project builds a version-keyed runner base image with
Packer. The image contains the common Ubuntu packages and the current
coordinator adapter's runner binary, but no registration token, runner name, or
job data. If the protected Project root contains `.dim/ci/qemu-cache.bash`,
trusted Packer provisioning executes it inside the base-image guest with the
cache directory as its only argument. The hook content digest selects the
Project's base-image cache key. Workflow changes can modify only their
disposable qcow2 overlay, not the Project's persistent base image. Named QEMU capacities share the completed qcow2 through a
Project-scoped cache volume; a cross-container file lock serializes the first
build and the completed image is published atomically. Every job still boots a
fresh overlay and receives its ephemeral registration only after boot. Deleting
the final QEMU capacity removes both shared dispatch state and this image cache.
Changing a pinned image input selects a new cache key rather than modifying an
image that another capacity may be using.

The cache hook is optional and belongs in the protected root because it is the
only Project code allowed to populate persistent runner state. Test orchestration
and artifact-specific verification should remain in ordinary development
repositories. The hook runs inside the disposable Packer guest, receives no
host socket or coordinator credential, and cannot access another Project's
cache volume.

Creating a QEMU runner adds only its managed supervisor hostname to Gitea's
webhook allowlist and restarts the managed Gitea service to apply that setting.
DIM does not enable unrestricted private-network webhook delivery.

The DIM repository selects this label for automatic host-backend verification on non-draft
pull requests in its managed development host. Draft pull requests and branch
pushes skip the expensive gate. Four independent jobs run `just ci kvm BACKEND`
for Sysbox, gVisor, rootless Podman, and runc, matching the KVM backend-installer
verification required for a release. Named host capacities claim these common
`dim-qemu` jobs without appearing in the workflow. After installing a DIM
version that adds or changes runner labels, restart the runner once:

```bash
dim ci runner restart dim release
dim ci runner create dim release-1 qemu
dim ci runner create dim release-2 qemu
dim ci runner status dim release-1
```

Restart every existing QEMU runner after this scheduler upgrade before adding
another capacity. DIM rejects a mixed old/private and new/shared scheduler
topology because both could otherwise react to the same capability event.

Each status must include a ready QEMU `executor` record with `dim-qemu` and a
distinct supervisor name. Workflows continue to select only
`runs-on: dim-qemu`; capacity names are host lifecycle configuration and do not
belong in tracked Project code. Creation detects host KVM, while successful VM readiness also
requires nested virtualization from the host KVM module. `dim ci runner logs
dim primary` follows the normal Sysbox runner;
use `dim ci runner logs dim release` when diagnosing VM boot,
registration, or replacement.

An individual VM boot, provisioning, registration, or job failure is scoped
to that queued job. The webhook service logs the job ID and supervisor exit
status, removes it from the in-flight set, and continues processing later
queued jobs. Repeated webhook responses without a corresponding
`qemu-ci: start disposable runner VM` line indicate that the event did not
select `dim-qemu`; a previous supervisor failure must not disable demand
processing.

The Sysbox runner has concurrency one. Its nested daemon, disposable job
containers, registration data, and resource limits live outside workspace
state. It does not mount the host Docker socket or receive DIM workspace
credentials. The default outer isolation runtime is `sysbox-runc`; the inner
daemon is rootful but cannot escape that system-container boundary. Override
`DIM_CI_RUNNER_RUNTIME` only with another runtime that can safely support the
nested daemon.

## Resources

The runner fallback is 4 CPUs and 8 GiB of memory. Sysbox runners additionally
default to 2048 processes. Installation defaults can be changed:

```bash
dim ci runner defaults set --cpus 6 --memory 12GiB --pids 4096
```

A named runner can override them:

```bash
dim ci runner create example primary sysbox --cpus 8 --memory 16GiB --pids 4096
dim ci runner create example release qemu --cpus 6 --memory 12GiB
```

`restart` preserves an existing runner override. Delete and create the runner
again without flags to return to inherited defaults.

For QEMU, `--cpus` must be an integer and maps to guest vCPUs; `--memory` maps
to guest memory. The supervisor container receives the same CPU limit, the
guest memory plus 2 GiB of overhead, and a fixed 1024-process boundary. A
process override applies only to Sysbox because the supervisor's host cgroup
does not define the guest's process policy. These are limits, not
reservations; while idle there is no VM or guest memory. Each job uses a
disposable 64 GiB overlay.

The QEMU host-install smoke verifies the Sysbox limits in a clean
Ubuntu guest rather than relying on a development workspace's delegated
cgroup hierarchy.

## Lifecycle

```bash
dim ci runner list
dim ci runner logs example primary
dim ci runner start example primary
dim ci runner stop example primary
dim ci runner restart example primary
dim ci runner delete example primary --yes
```

`create` requires a new Project/runner identity. `start` requires a stopped
runner and preserves its state; for QEMU it recreates the supervisor and
webhook because `stop` removes the webhook credential. `restart` reconciles an
existing runner while preserving its executor and resource override. `delete`
permanently removes its provider registration, container, volume, and state.

The coordinator integration is provider-specific, but runner state, lifecycle,
and executor capabilities are provider-neutral. Managed Gitea Actions is the
initial adapter. `dim-qemu` is an executor capability that any Project workflow
may select; the disposable VM boundary and label do not encode DIM's particular
release policy or depend on Gitea-specific execution behavior.

The executor is selected when a runner is created. Later lifecycle
operations address the stable Project/runner identity, so managing one runner
never starts, replaces, or deletes another. Multiple Sysbox and QEMU runners
provide parallel capacity while retaining concurrency one per runner. QEMU
supervisors share provider-neutral demand and claim state; the Gitea webhook is
only the current adapter that translates coordinator events into that demand.
Replacing the managed Git host therefore does not change workflow labels or
expose capacity ownership in Project code.

As a pre-stable state contract, earlier CI runner state is not migrated
automatically. Schema 4 records effective QEMU resources so overrides survive
restart. Before upgrading from schema 3, use the installed older CLI to delete
each runner, then recreate it with the new CLI; alternatively clean up its
managed containers, volumes, provider registrations, and state manually.
