# External URL Route Policy

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
