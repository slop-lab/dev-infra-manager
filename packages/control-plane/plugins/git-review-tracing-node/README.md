# Local Node review tracing plugin

`@slop-lab/dim-control-plane-plugin-git-review-tracing-node` supplies the `node`
runtime for `@slop-lab/dim-control-plane-plugin-git-review-tracing`. Install both
control-plane plugins and select `runtime: "node"` in a traced review matcher.
The plugin configuration is an empty object.

This adapter executes the detector on the control-plane machine using the
shared [Node runtime](../../../git-review-tracing/runtimes/node/README.md). Its execution host
needs Docker and the exact pinned image described there. The runtime package
owns the detector API, TypeScript support and containment rules.

To execute on a configured host worker, install the host review-tracing-node
plugin there and select the scheduled control-plane runtime instead. This uses
the same scheduler and worker lease loop as CI tasks; no SSH connection or
second worker daemon is required.
