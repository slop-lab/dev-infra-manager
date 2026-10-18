# @slop-lab/dim-core

The base development API is `@slop-lab/dim-core/workspace`. It provides ordinary
Git source acquisition, workspace state/storage validation, application lifecycle
operations and the container runtime. It does not load managed Git, CI schedulers
or QEMU services. Node.js 24/26 and a Linux runtime host are supported.

```ts
import {
  acquireWorkspaceSource, ContainerWorkspaceRuntime, ProcessRunner,
  WorkspaceService, WorkspaceStore
} from "@slop-lab/dim-core/workspace";

const service = new WorkspaceService(
  new WorkspaceStore("/absolute/host/state"),
  new ContainerWorkspaceRuntime(new ProcessRunner()),
  acquireWorkspaceSource
);
const workspace = await service.create({
  name: "dev",
  source: { url: "https://example.com/team/app.git" }
});
await service.stop(workspace.name);
await service.recreate(workspace.name);
```

Source acquisition stages an independent committed checkout. The runtime owns
only its labeled container, private network and home/checkout/Docker volumes.
The application owns state transitions and locking. Transport and command
presentation belong to the CLI, and SSH executes these same application
operations on the selected host.

`create` initializes source once; subsequent start/restart/recreate does not
reset user files. `recreate` preserves existing storage. `discard` removes it.
Resource updates report whether container recreation was necessary. Failed
initialization remains distinguishable from a ready workspace, and malformed
state is rejected at the storage boundary.

`connect(name, port, { stdin, stdout, stderr, signal, workspaceId? })` streams
bytes to one TCP port on the workspace's loopback interface. Runtime ownership
is checked before connecting; no host address or control socket is passed into
the workspace. Long-lived clients can bind connections to `workspaceId` so
reusing a display name cannot redirect them to another workspace. Connection
failures do not rewrite lifecycle state.

The root export and `/workspace` expose the base API. Optional managed
workspaces, native Git clients, controllers, ordinary CI, QEMU and plugin
integration live in `@slop-lab/dim-managed`; they are not installed by the base
CLI dependency graph. The base package has no production dependencies or
service binaries.

See the [architecture rework plan](../../../specification/docs/architecture-rework-plan.md)
for responsibility boundaries, optional service composition, implementation
sequence and verification expectations. Preserve the installer facade's public
namespace while removing obsolete internal contracts deliberately.
