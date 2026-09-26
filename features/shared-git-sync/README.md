# Shared Git-host synchronization

This service lets DIM hosts request repository fetch and selective publication
on the physical host that owns a shared Gitea repository. It is deliberately
not a remote shell. Its private registry resolves a DIM Project ID and alias to
one bare repository and one Gitea receive URL; requests never supply either
managed filesystem path.

Build the exact release image from the installed CLI, publish that explicit
non-`latest` tag, and record the registry digest used for deployment:

```bash
image=registry.example/dim-git-sync:0.9.0
dim repo sync-service image build "$image"
docker push "$image"
docker image inspect "$image" --format '{{index .RepoDigests 0}}'
# Deploy only the reported registry.example/dim-git-sync@sha256:... identity.
```

Treat the tag as a build and publication destination, not a deployment pin.
Record the reported digest in the Git-host service definition so a later tag
move cannot change the reviewed service bytes.

Copy `service-config.json` to the Git host and replace every placeholder. The
image defaults to service UID and GID `10001`; make the mode-`0600` config and
private durable `/var/lib/dim-git-sync` state accessible only to the effective
service identity. Mount Gitea's repository root read-write at
`repositoriesRoot` and grant that identity the same filesystem access Gitea
requires for those bare repositories, using an operator-managed group or ACL
when the Gitea storage owner differs. Terminate TLS in front of the service
unless it is confined to an explicitly isolated network. The service needs no
Gitea administrator credential. Each `managedUrl` should be a Gitea clone URL
reachable from the service, such as the `gitea` DNS name on a private container
network, so visible fetch updates traverse receive hooks and provider metadata
updates. Use loopback only when both processes deliberately share one network
namespace.

The transport policy is an allowlist. HTTPS and HTTP entries contain
hostnames. SSH and scp-style URLs require an allowed SSH hostname and use the
service account's private key, SSH configuration, and pinned host keys.
Absolute and `file://` paths must resolve below one of `localRoots` on the Git
host. The service rejects `git://`, remote helpers such as `ext::`, credentials
in URLs, query strings, and fragments.

Copy `host-connection.json` to each DIM host, set the same stable `hostId` used
by that host's external Gitea connection, make it owned by the DIM user with
mode `0600`, and export:

```bash
export DIM_GIT_SYNC_CONNECTION_FILE="$HOME/.config/dim/git-sync.json"
dim repo fetch acme root --prune
dim repo publish acme root
```

The bearer token authorizes every repository listed in that service registry.
Protect the endpoint and token as host-administration secrets. HTTP upstream
credentials are forwarded only in the operation body and exist only in
subprocess memory; the persistent `dim-upstream` remote contains the reviewed
credential-free URL. A missing connection, unknown alias, or disallowed
transport fails closed without a temporary-clone fallback.
