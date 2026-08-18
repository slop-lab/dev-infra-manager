# Managed CI runners

DIM workspaces remain the primary development and verification environment.
Managed CI runners repeat pull-request checks in a separate checkout and
container environment so their result can be used as independent review
evidence.

Enable the single runner for a Project:

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
container-integration workflow, whose controller sockets and nested Docker
bind mounts must share one filesystem namespace. Other workflow jobs remain
in disposable job containers. After upgrading DIM across a label change,
run `dim ci runner enable PROJECT` once to replace the stored runner
registration and publish the new labels.

The runner has concurrency one. Its nested daemon, disposable job
containers, registration data, and resource limits live outside workspace
state. It does not mount the host Docker socket or receive DIM workspace
credentials. The default outer isolation runtime is `sysbox-runc`; the inner
daemon is rootful but cannot escape that system-container boundary. Override
`DIM_CI_RUNNER_RUNTIME` only with another runtime that can safely support the
nested daemon.

## Resources

The built-in fallback is 4 CPUs, 8 GiB of memory, and 2048 PIDs. Installation
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

The QEMU host-install smoke verifies these effective cgroup limits in a clean
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

The coordinator integration is provider-specific, but the runner state,
resource model, CLI, and executor are provider-neutral. The initial adapter is
for managed Gitea Actions. A future QEMU executor can use the same contract
with a `dim-qemu` label and a disposable VM overlay.
