# Web workspace lifecycle operator gate

This disposable gate drives the production Web operations console through a
reviewed Chromium executable. Web invokes a fixture-owned wrapper around the
built public DIM CLI with `--host local`; the CLI invokes the built host entry
through `DIM_HOST_EXECUTABLE`. The host uses an isolated `HOME`, XDG directories,
plugin directory, managed state and `DIM_STATE_ROOT`. Git source acquisition uses
an owned loopback Smart-HTTP repository with no embedded credentials.

Prerequisites are checked before workspace creation: Linux, Node 24 or 26, a
reachable Docker daemon, `sysbox-runc` listed by Docker, the already-built image,
the built CLI/host artifacts, and an executable Chromium path. The gate never
pulls or builds images, installs runtimes, copies host sockets or credentials, or
deploys services.

Run the mutation-free check first:

```sh
pnpm --dir tests exec tsx ../scripts/checks/web-workspace-lifecycle.ts IMAGE \
  --chromium /absolute/path/to/chromium --preflight-only
```

Run the real private Web, built CLI/host and owned-controller connection probe
without creating a workspace or inspecting the selected image:

```sh
pnpm --dir tests exec tsx ../scripts/checks/web-workspace-lifecycle.ts unused \
  --chromium /absolute/path/to/chromium --connection-only
```

On a disposable Sysbox host, run the full release gate:

```sh
pnpm --dir tests exec tsx ../scripts/checks/web-workspace-lifecycle.ts IMAGE \
  --chromium /absolute/path/to/chromium
```

The host or its parent VM/container must retain an independent outer resource
ceiling. The scenario removes only one inner limit at a time while the other two
remain finite, then restores CPU 1, memory 2g and PIDs 512.
Docker inspection is paired with reads of `cpu.max`, `memory.max` and `pids.max`
from the workspace process cgroup and its visible ancestors. A matching cgroup
level must expose all three requested values; unlimited checks therefore still
require the other two finite ceilings at that same level.

Cleanup lists only the fixture's initially empty private workspace store, learns
the unique owned UUID after a partial create when necessary, and always uses
`--expect-id`. Identity reuse, unexpected records, discard failure or private
controller shutdown failure retains the private fixture root for operator
inspection instead of deleting evidence. The global controller is never stopped.

Managed `dim://` multi-repository creation is intentionally not fabricated here.
It requires a separately prepared, fixture-owned Native Git/control-plane
authority and explicit host plugin connection. Control-plane and workspace host
roles belong in separate disposable VMs when VMs are used. Reuse the repository's
existing Native Git browser fixtures for that extension; do not point this gate
at production role files or an installed operator account.
