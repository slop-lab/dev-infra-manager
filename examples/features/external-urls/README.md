# Example: External URLs

## Runnable recipe

[`recipe.json`](recipe.json) owns the exact host/control-plane plugin selection,
repository paths and executable stages. From the DIM repository root:

```bash
node scripts/examples/run.ts examples/features/external-urls install-host
node scripts/examples/run.ts examples/features/external-urls install-control-plane
node scripts/examples/run.ts examples/features/external-urls verify
```

`verify` is a fast local check using the locked source toolchain; it does not
install plugins or authenticate provider accounts. `dev` runs this directory's
actual setup/service script after the prerequisites below are configured.
For workspace recipes, set `DIM_EXAMPLE_WORK` to a fresh absolute operator
directory; source templates are copied and committed there, never overwritten.

This provider/service recipe has no automatic `verify-vm` stage: its explicit
runtime prerequisites are not silently provisioned by the generic VM journey.
See the [recipe runner](../../README.md) for shared options and the heavy VM gate.

Expose a service from an ordinary Git workspace through an optional host-owned
HTTP ingress. This example needs no native Project or control plane. Run the
DIM commands on the host that owns the workspace; neither a controller socket
nor a host Docker socket is mounted into it.

For a temporary tunnel, use `dim forward WORKSPACE 3000:3000` instead. The URL
plugin is useful when the host should retain a named route with explicit
approval.

Required components: base Docker/Sysbox workspace support, matching managed
administration (`dim installer install core --with-managed`), and
`@slop-lab/dim-host-plugin-external-urls@0.10.0` installed on the workspace host.
The host controller and ingress provide this integration; no native Git service,
CI worker, DNS plugin or separate control-plane deployment is required for the
loopback HTTP example. An arbitrary source repository needs no declaration;
if the integration is intrinsic to that repository, its `.dim/workspace.json`
can declare `{"plugins":["@slop-lab/dim-host-plugin-external-urls@0.10.0"]}`.
That declaration does not install managed administration or configure ingress.

## Start a service

Create a workspace from your own Git source, or use an existing workspace:

```bash
dim image build
dim create "$SOURCE" external-dev
dim exec external-dev -- node --input-type=commonjs -e \
  'require("node:http").createServer((req,res)=>res.end("hello-from-workspace\n")).listen(3000,"127.0.0.1")'
```

Keep that command running. In a second host terminal, install the reviewed
optional component and plugin, then configure a loopback-only ingress:

```bash
dim installer install core --with-managed
dim installer install plugin '@slop-lab/dim-host-plugin-external-urls@0.10.0'
bash configure-ingress.bash
bash request-urls.bash external-dev
```

The configuration script creates an HTTP ingress named `local-http` for
`dev.test:8080`, listening only on host `127.0.0.1`, and requires host approval.
Inside the workspace, an agent can make the same limited request without a
host CLI or operator token:

```sh
dim-workspace plugins
dim-expose --name app --port 3000 --ingress local-http
dim-expose list
```

The request script uses the host CLI's scoped workspace grant to request
`external-dev--app.dev.test`. It does not run an administration helper inside
the container. The controller starts on demand; if its plugin configuration
changed while it was already running, run `dim controller restart` first.

## Approve and use the route

Inspect the request's JSON output and copy its route ID:

```bash
dim external-url list --workspace external-dev --json
curl --resolve external-dev--app.dev.test:8080:127.0.0.1 \
  --silent --output /dev/null --write-out '%{http_code}\n' \
  http://external-dev--app.dev.test:8080/
dim external-url approve URL_ID
curl --resolve external-dev--app.dev.test:8080:127.0.0.1 \
  --fail http://external-dev--app.dev.test:8080/
```

The first request returns 404 while approval is pending. After host approval it
returns `hello-from-workspace`. Approval is a host-admin operation; a scoped
workspace token cannot approve routes.

The route selects workspace loopback port 3000. To target one container in the
workspace's nested Docker engine, request a route with `--container NAME`.
Deeper container paths are not supported. The controller verifies core runtime
ownership and uses an in-agent relay; requests cannot supply an arbitrary host
upstream address.

## Cleanup and verification

```bash
dim external-url revoke URL_ID --workspace external-dev
dim discard external-dev --yes
```

Revocation closes existing flows. Discard or same-name replacement also denies
new HTTP requests, WebSocket upgrades and TCP connections through core UUID
checks, without a controller restart. Restarting a workspace preserves its
identity; deleting it and reusing the name creates a different identity.

The live plugin tests cover pending approval, revocation and identity reuse.
The actual container relay smoke checks concurrent binary streams, half-close,
relay reuse, ownership fencing and discard cleanup:

```bash
node scripts/checks/controller-workspace-relay-smoke.ts WORKSPACE_IMAGE
```

Run that command from the repository root after building matched packages and a
Sysbox workspace image. Public HTTPS/DNS configuration is documented in
[External workspace URLs](../../../docs/guides/external-urls.md).
