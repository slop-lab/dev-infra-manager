# Managed Git on the base workspace runtime

Managed Git adds a source adapter to the base workspace service. `dim create
dim://PROJECT NAME` uses the selected host, proves that the Project is ready,
and seeds its protected snapshot into the same unprivileged Sysbox container
used for ordinary Git URLs. `dim ls`, `show`, `exec`, `stop`, `start`, `restart`,
`recreate`, `resources` and `discard` operate on that one core workspace record.

The runtime owns one container, one private bridge and three named volumes:
home, checkout and nested Docker data. Recreate preserves the volumes and
bridge identity. Discard removes owned storage and the bridge. Start and
recreate preserve local edits; they do not clone or reset the checkout again.

Managed state is a separate attachment keyed by the core workspace UUID. It
records the native Git identity, selected Project, protected snapshot, review
policy revisions and private broker connection. Native fields do not change
the core record or introduce another lifecycle manager.

The host-side broker listens on the workspace's private bridge gateway. The
checkout receives only a scoped broker credential. The broker obtains short
Git leases using operator credentials kept outside the workspace. It exposes
exact Git smart-HTTP requests for one Project, and validates the current core
UUID and running, initialized state on each request. Discard or name reuse
revokes the old attachment. A later start or exec restores a missing broker.

A reviewed protected fast-forward keeps the workspace's Git access usable;
it does not reset its persistent checkout. Policy changes require a fresh
workspace attachment. Project `.dim` files are ordinary repository content:
DIM does not automatically execute setup, entrypoint or teardown hooks. Run
selected development tasks explicitly through `dim exec`.

See [the base API](../../../../packages/host/core/README.md) and the
[CLI reference](../../../../packages/cli/README.md) for runtime and remote-host behavior.
