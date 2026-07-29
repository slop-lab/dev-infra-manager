# `@slop-lab/dim-controller-proxy`

This package lets reviewed Project-root code expose a restricted DIM
controller Unix socket to an untrusted development container. The proxy keeps
the original workspace grant and controller socket in the trusted container.

The built-in External URL preset permits filtered discovery, list, request,
and individual revoke operations for explicitly named ingresses:

```bash
dim-controller-proxy external-url \
  --listen /run/dim/dev-controller/controller.sock \
  --ingress tailscale-main
```

Advanced reviewed policies can use the Node.js API:

```js
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
        .filter(({ name }) => name.startsWith("tailscale-"))
        .map(({ name }) => name)
    })
  ]
});
await proxy.listen();
```

Only mount the proxy socket directory into development containers. Never pass
them the original `DIM_CONTROLLER_TOKEN` or `/run/dim/controller`.
