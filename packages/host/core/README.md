# @slop-lab/dim-host-core

The base development API is `@slop-lab/dim-host-core/workspace`. It provides ordinary
Git source acquisition, workspace state/storage validation, application lifecycle
operations and the container runtime. It does not load native Git authority, CI schedulers
or QEMU services. Node.js 24/26 and a Linux runtime host are supported.

```ts
import {
  acquireWorkspaceSource, ContainerWorkspaceRuntime, ProcessRunner,
  WorkspaceService, WorkspaceStore
} from "@slop-lab/dim-host-core/workspace";

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
only its labeled container, private network and home/checkout/Docker/temp volumes.
The application owns state transitions and locking. The CLI owns host selection and transport. Command parsing, help and presentation
belong to this host application, including when invoked through SSH.

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

The root export and `/workspace` expose workspace state, lifecycle, runtime and
guest-delivery APIs. `/controller` exposes generic route, administration,
host-input and extension registration; `/controller/cli` supplies controller
commands and transport helpers.

`/application` composes the explicitly installed host plugins, source providers,
runtimes, checkout requirements and scoped guest bridge. Its `dim-host` executable
interprets commands and loads optional operator integrations without depending on
the DIM CLI. Controller, control-plane and workspace command owners are selected
before their implementation graphs are loaded. Control-plane administration is
loaded only for its own commands.
The CLI uses the retained [v1 wire contract](../../../docs/specs/cli-host-protocol-v1.md)
from `@slop-lab/dim-contracts-cli-host`; domain operations stay inside the host.
Capability negotiation does not load feature implementations. The guest
bridge launches its own host-core entrypoint; its generation binds that launcher
and application code so updates fence previous bridge credentials.

`WorkspaceHostPlugin` defines optional runtime, command, guest-preparation and
execution-routing capabilities. Native Project acquisition belongs to
`@slop-lab/dim-host-plugin-native-git`; CI workers and VM runtimes have their own
host plugins. Control-plane authority and coordination live in separate
control-plane packages. The host application composes explicitly enabled capabilities; the CLI routes
commands to that application on the selected host.

See [plugin responsibilities](../../../docs/guides/plugins.md) and
[host/guest preparation](../../../docs/guides/plugin-scopes.md).
