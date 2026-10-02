# `@slop-lab/dim-controller-proxy`

A policy-constrained Unix-socket proxy for exposing selected DIM workspace
controller operations to an untrusted development container. Reviewed
Project-root code runs the proxy in the trusted workspace container; only the
new restricted socket is mounted into the child container.

## Installation

```bash
npm install --save-exact '@slop-lab/dim-controller-proxy@0.9.0'
```

The package is ESM-only, requires Node.js 24 or 26, includes TypeScript
declarations, and installs the `dim-controller-proxy` and
`dim-development-service` executables.

## Agent preset

The agent preset builds an exact-route, deny-by-default policy, filters
controller discovery to that allowlist, and removes host-input discovery. This
form allows an agent to request a restart of only the workspace identified by
the trusted upstream grant:

```bash
dim-controller-proxy agent \
  --listen /run/dim/agent-controller/controller.sock \
  --allow-workspace-restart \
  --allow-workspace-resources
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

The resource option permits only bodyless `GET /api/workspace/resources` for
the workspace bound to the upstream agent grant. Mount the derived socket into
the agent and set `DIM_CONTROLLER_SOCKET` to it; do not pass the upstream grant.
The packaged read-only helpers then provide JSON and `nproc`-compatible output:

```bash
dim-workspace-resources show
dim-nproc
```

`dim-nproc` floors fractional assignments, returns at least one, and caps the
result by CPUs visible to the process. An unavailable or unlimited (`max`)
assignment fails instead of reporting host capacity. Neither helper accepts a
workspace selector or reads Docker/cgroup state.

## External URL preset

The built-in preset permits discovery, listing, creation, and individual
revocation only for explicitly allowed ingresses:

```bash
dim-controller-proxy external-url \
  --listen /run/dim/dev-controller/controller.sock \
  --ingress local-http \
  --ingress public
```

By default this preserves the generic External URL capability: a caller may
select any target accepted by the workspace-scoped controller. A reviewed
Project can instead constrain the socket to one exact container path,
protocol, and port:

```bash
dim-controller-proxy external-url \
  --listen /run/dim/web-url/controller.sock \
  --ingress https-ts \
  --bind-containers-json '["agent"]' \
  --bind-protocol http \
  --bind-port 4096
```

When binding options are present, all three are required. The proxy rejects
creation for any other target, omits mismatched entries from list responses,
and denies revocation of mismatched entries. Ingress filtering still applies.

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
        .map(({ name }) => name),
      boundTarget: { containers: ["agent"], protocol: "http", port: 4096 }
    })
  ]
});

await proxy.listen();
```

`boundTarget` is optional. Omitting it retains ingress-only target policy;
supplying it injects that exact target on creation and enforces it for list and
revoke operations.

## Development services

`dim-development-service` lets tools expose named loopback services without
embedding tool names or application ports in reviewed Project configuration.
Trusted Project lifecycle code first keeps one ingress-filtered proxy bound to
the agent container and the helper's fixed gateway port:

```bash
dim-controller-proxy ensure external-url \
  --listen /run/dim/development-url/controller.sock \
  --ingress https-ts \
  --bind-containers-json '["agent"]' \
  --bind-protocol http \
  --bind-port "$(dim-development-service gateway-port)"
```

Mount only that socket into the agent and set
`DIM_DEVELOPMENT_URL_SOCKET=/run/dim/development-url/controller.sock`. Any tool
in the agent can then expose an HTTP service already listening on its own
loopback:

```bash
dim-development-service expose \
  --name preview --port 5173 --ingress https-ts --require-scheme https
```

The command prints the policy-selected external URL. It lazily starts one user-owned gateway
listening on `0.0.0.0:31887` so the trusted ingress can reach it. The helper
sends only the ingress and logical service name. A generic target-bound proxy
strips the logical name and injects the bound target. A narrower dedicated
socket may add reviewed `--bind-service-subdomain SERVICE=SUBDOMAIN` mappings;
it injects the exact mapped subdomain and rejects unlisted service names and
caller-supplied authority fields. The helper then routes both returned
exact authorities, the selected slug and stable permalink, to the local
application at `127.0.0.1:5173`. HTTP and WebSocket upgrades use the same
route. Repeating the
same service name with another local port retains its URL and URL ID while
updating the gateway route. The gateway is shared across tool launchers and is
not owned or stopped by any one launcher.

Use `dim-development-service gateway-port` rather than copying `31887` into
Project policy. If a nested container route must publish the gateway, map that
queried port to the same container port (`G:G`); External URL registration
stores the bound gateway port when the URL is created. Application ports remain
internal gateway state and need no Project mapping.

The bound proxy, not the caller, injects the reviewed external target and any
configured service subdomain. This prevents the agent from selecting another
container target or public authority. It is not a
per-process boundary inside the agent: any code with the socket can expose any
service allowed by that socket through the agent's existing loopback authority.
Keep generic and service-specific capabilities on distinct sockets when both
are needed.

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
