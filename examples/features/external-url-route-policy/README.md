# External URL Route Policy

> **Archived predecessor example.** Retained for historical source comparison;
> it is not a complete current deployment recipe. Use the maintained
> [External URLs recipe](../external-urls/README.md) for setup and prerequisites.

The standalone server below exercises the still-supported trusted route-policy
webhook protocol. It requires Node.js 24/26 and a private host Unix socket.
Integrating it requires managed administration plus
`@slop-lab/dim-plugin-external-urls@0.10.0` on the workspace host and an
operator-configured ingress referencing that socket. Native Git, CI and a DNS
plugin are not required for a local HTTP ingress. This directory is not a source
repository template and declares no workspace plugins of its own.

This advanced example replaces the default `WORKSPACE--` subdomain policy
with a trusted Unix-socket webhook. The basic External URL example remains
focused on ordinary workspace-qualified URLs.

Start the policy beside the DIM controller:

```bash
node examples/features/external-url-route-policy/policy-server.mjs \
  /run/user/"$(id -u)"/dim/external-url-policy.sock
```

Add `"routePolicy"` to an `http` or `caddy` ingress argument:

```json
{
  "routePolicy": {
    "driver": "webhook",
    "argument": "{\"url\":\"unix:/run/user/1000/dim/external-url-policy.sock\"}"
  }
}
```

The example permits a request for `docs`, rewrites it to `shared-docs`, and
rejects every other unprefixed name. DIM still validates the returned
subdomain, checks hostname conflicts, and retains exclusive control over the
workspace target.
