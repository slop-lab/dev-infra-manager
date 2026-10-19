# `@slop-lab/dim-host-plugin-cache-server`

Optionally run host-owned Docker Hub, npm, PyPI and APT cache services. This
server plugin owns deployment and persistent cache storage; the separate
[`host-mirrors`](../mirrors/README.md) client owns workspace and CI
configuration. Neither requires a control-plane service, and the server does
not require the client plugin.

```sh
dim installer install plugin '@slop-lab/dim-host-plugin-cache-server@0.10.0'
dim cache-server ensure
dim cache-server endpoints
```

`ensure` independently reconciles four compiled adapters using reviewed image
digests: a Docker registry pull-through cache, Verdaccio npm cache, devpi PyPI
mirror and apt-cacher-ng. The PyPI service disables unused search indexing. It waits for listeners before publishing a private
schema-version-1 URL catalog at
`$DIM_STATE_ROOT/services/package-caches.json`. The default DIM state root is
`$XDG_STATE_HOME/dim`, or `~/.local/state/dim`. `endpoints` prints the saved
catalog without deploying services. The client reads the same catalog without
importing this package or starting servers.

## Host networking and ownership

Each service publishes its fixed container port on the **default Docker bridge's
IPv4 host gateway**, with an automatically allocated host port. It does not bind
`0.0.0.0`, a LAN interface or a caller-selected public address. The returned URLs
are reachable by host processes and ordinary Docker bridge CI consumers; clients
do not need access to the server's private Docker network. This local catalog
is not a promise of network access from another physical machine.

Private random identities fence the network, named volumes and containers.
Foreign names or unexpected mounts, privileges, network identities or host port
bindings are rejected rather than adopted. Reconciliation starts stopped owned
containers by immutable ID and checks their effective publication afterward.
Image/configuration replacement preserves named cache volumes. Workspace
creation, recreation and discard do not own or remove cache data.

Server state lives in `DIM_STATE_ROOT/plugins/cache-server`, independently of
workspace storage. Existing legacy registry caches are not adopted or deleted.
There are no host Docker daemon rewrites and no workspace-supplied commands,
environment policies, images or config templates. Protocol settings are compiled
adapter code. Cache services expose public reads; guest credentials and host
package-manager credentials are not copied into them.

## Separate cache hosts and NAS placement

A workspace host may instead use independently operated cache services on a NAS
or another server. Give the client a catalog with the same four URL fields and
run `dim mirrors configure FILE`; see the client README for its exact schema.
The operator owns TLS, network reachability, storage and service authentication
outside this local deployment. URL credentials are not supported by the client
catalog. No server package needs to be installed on that workspace host.

The built-in server uses Docker-managed named volumes. It does not automatically
move those volumes to a NAS or expose its private bridge publications remotely.
An operator can deploy remote services with suitable storage/networking and
change client URLs without changing consumer code or relying on a workspace's
lifetime. Existing cache data transfer is a separate operator operation.

Lifecycle tests live in `tests/host/plugins/cache-server/`; disposable real npm
and PyPI cold/warm/offline consumer checks live in
`scripts/checks/package-cache-smoke.mts`. Runtime gates use random owned
resources and must not be aimed at installed cache volumes.
