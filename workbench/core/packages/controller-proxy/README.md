# `@slop-lab/dim-controller-proxy`

A policy-constrained Unix-socket proxy for exposing selected DIM workspace
controller operations to an untrusted development container. Reviewed
Project-root code runs the proxy in the trusted workspace container; only the
new restricted socket is mounted into the child container.

## Installation

```bash
npm install --save-exact '@slop-lab/dim-controller-proxy@0.8.0'
```

The package is ESM-only, requires Node.js 24 or 26, includes TypeScript
declarations, and installs the `dim-controller-proxy` executable.

## Agent preset

The agent preset builds an exact-route, deny-by-default policy, filters
controller discovery to that allowlist, and removes host-input discovery. This
form allows an agent to request a restart of only the workspace identified by
the trusted upstream grant:

```bash
dim-controller-proxy agent \
  --listen /run/dim/agent-controller/controller.sock \
  --allow-workspace-restart
```

The same helper is available to reviewed Node.js policy code:

```ts
import { createAgentControllerProxy } from "@slop-lab/dim-controller-proxy";

const proxy = createAgentControllerProxy({
  listen: "/run/dim/agent-controller/controller.sock",
  routes: [{ method: "POST", path: "/api/workspace/restart" }]
});
await proxy.listen();
```

Request bodies are denied by default. A route that needs one must set an
explicit `maxBodyBytes` limit.
Allowing self-restart lets the agent trigger reviewed Project setup again and
may affect availability. Project root code must opt in deliberately; the agent
still cannot select another workspace or access a host-admin route.

## External URL preset

The built-in preset permits discovery, listing, creation, and individual
revocation only for explicitly allowed ingresses:

```bash
dim-controller-proxy external-url \
  --listen /run/dim/dev-controller/controller.sock \
  --ingress local-http \
  --ingress public
```

It reads the trusted upstream socket and bearer grant from
`DIM_CONTROLLER_SOCKET` and `DIM_CONTROLLER_TOKEN`. Options
`--directory-mode` and `--socket-mode` accept octal Unix modes; their defaults
are `0700` and `0660`.

Mount only `/run/dim/dev-controller` into the child container and configure the
child to use that socket. Never pass it the original token or mount the
original controller socket directory.

## Node.js API

Reviewed code can construct a proxy from capability objects:

```ts
import { createControllerProxy } from "@slop-lab/dim-controller-proxy";
import {
  externalUrlProxy,
  getExternalUrlIngresses
} from "@slop-lab/dim-controller-proxy/external-url";

const ingresses = await getExternalUrlIngresses();
const proxy = createControllerProxy({
  listen: "/run/dim/dev-controller/controller.sock",
  capabilities: [
    externalUrlProxy({
      allowedIngresses: ingresses
        .filter(({ name }) => name.startsWith("dev-"))
        .map(({ name }) => name)
    })
  ]
});

await proxy.listen();
```

`createControllerProxy` also accepts explicit `sourceSocket`, `token`,
`maxBodyBytes`, and socket/directory modes. The default request-body limit is
65,536 bytes. Requests not authorized by any capability receive HTTP 403.

Custom reviewed policy modules can be started with
`dim-controller-proxy --config ./proxy.mjs`; importing that module is expected
to start and own the proxy lifecycle.

This proxy reduces the exposed controller API but does not make unreviewed
policy code trustworthy. See the
[trust-boundary documentation](https://github.com/slop-lab/dev-infra-manager/blob/main/specs/02-boundaries-and-trust.md)
and [source repository](https://github.com/slop-lab/dev-infra-manager).
