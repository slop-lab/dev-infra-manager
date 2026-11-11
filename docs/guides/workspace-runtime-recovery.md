# Workspace runtime identity recovery

A container can be running while its guest runtime mounts are unusable. Before
source/plugin preparation, DIM reads and validates
`/proc/sys/kernel/random/boot_id` as the workspace user. The read-only probe has
a four-second guest deadline and a five-second host abort deadline, followed by
at most two seconds of process-group termination grace. Failure preserves
the running workspace and records an integration preparation diagnostic with the
exact UUID and read failure code. It does not probe cache URLs, repair LLM
bindings, rotate credentials, stop processes or automatically restart anything.
An unknown boot identity must never authorize killing a presumed stale service.

`ENOTCONN` (transport endpoint not connected) on this path is evidence of a
runtime mount/read problem, not proof of its cause. Sysbox/FUSE state is a
possible explanation; this observation alone does not prove which host service
or event caused it. A running Docker container and healthy mirror URLs do not
disprove a guest mount failure. Preserve the original error and host journal
timestamps for the runtime owner.

## Operator-only bounded recovery

The coding agent must not execute this procedure against existing user
workspaces. The coordinator reviews the plan and authorizes an operator window.

1. On the selected host, inspect `dim show NAME --json`. Record the immutable
   `id`, runtime, image, initialized state, error, resources and actual runtime
   observation. Independently inspect the UUID-owned container, network and
   home/checkout/Docker/tmp volumes using
   `workspaceRuntimeResources(record)` and their exact `dim.workspace-id`,
   `dim.resource`, `dim.managed` and schema labels. A reused name, ownership
   conflict or missing retained data blocks recovery; do not adopt resources or
   fabricate empty replacement data.
2. Establish quiescence with the workspace owner/coordinator across every main
   session, subagent, team member and independent service or nested workload.
   A main OpenCode session reporting idle is insufficient. Missing team activity
   or an unreachable server means **unknown**, not idle. Do not use process
   absence in one API as authorization. Stop here until the owner explicitly
   checkpoints and authorizes interruption. Preserve checkout/home/private
   Docker/tmp data and existing credential files; keep backups private.
3. Review the exact UUID-bound keep-data action. After the checks above, an
   authorized operator can run:

   ```bash
   dim --host SELECTED_HOST recreate NAME --expect-id EXACT_UUID
   ```

   This replaces only the owned container while retaining its identity,
   network and four volumes. It interrupts all guest processes. It is not a
   host Docker/Sysbox restart and is not a guarantee to repair a host-wide mount
   fault. Registered services/sessions can resume automatically, which is why
   owner checkpointing and coordination are required before the action.
4. Verify the same UUID and owned storage, a valid guest `boot_id`, an ordinary
   `dim exec NAME -- true`, unchanged dirty/untracked checkout, home credential
   permissions/content and a preselected nested image/volume marker. Successful
   integration preparation clears the recorded preparation failure. Do not
   reset the checkout or reissue credentials to make readiness pass.
5. If exact recreation fails, retain the error and logs, keep remaining volumes
   intact and escalate to the runtime owner. Do not loop recreations, discard,
   prune, unmount host paths, restart Sysbox/Docker, change firewalls or inject a
   host socket. A host-wide intervention requires a separate inventory and
   reviewed maintenance plan for **all** affected workloads.

Incident UUIDs supplied by a coordinator identify resources, not authorization
to operate on them. If complete team idleness is unobservable, this procedure
does not authorize live recovery.

## Fresh-host compatibility is a separate failure

`namespace {"time" ""} does not exist` at Sysbox container start is a distinct
Docker/Sysbox incompatibility, not the stale boot-identity failure. See
[host readiness](../development/host-install-readiness.md) for exact diagnostic
recognition and an operator-reviewed setting that preserves existing daemon
configuration. The published bootstrap remains Ubuntu 24.04 amd64 with its
reviewed pins; observations on Ubuntu 26.10 do not extend that contract.

## Disposable regression

On an authorized disposable Linux Docker/Sysbox host, run:

```bash
pnpm install --frozen-lockfile
pnpm --dir tests exec tsx ../scripts/checks/workspace-runtime-recovery.ts /absolute/private/evidence
```

The test builds an owned image and creates a unique workspace. It mounts a
fixture-owned invalid identity file over the guest boot-identity path, invokes
normal agent preparation, and checks actionable diagnostics without stopping
the container. It then rejects a wrong UUID, explicitly recreates only its own
workspace, and checks valid identity, dirty/untracked checkout, home, private
credential content/mode, tmp, nested image and nested volume preservation.
Cleanup uses exact ownership-aware discard, never a broad prune. The JSON
receipt and failure diagnostic survive cleanup in the evidence directory.
This is a real mount-fault recovery test, not reproduction of spontaneous
ENOTCONN or proof of the fleet's underlying Sysbox/FUSE cause.

The candidate VM job in `.dim/ci/runner.yml` installs the reviewed host stack
only inside its disposable VM and runs this test. Its source and VM jobs must
be inspected independently. Retain exact-candidate logs/artifacts with hashes
before changing the ordinary qualification branch; a green source job alone
does not establish runtime recovery.
