# Workspace external routes for DIM Web

This optional Web plugin contributes **External routes** directly to each workspace
row. Install `@slop-lab/dim-web-plugin-external-urls` in the Web runtime and
`@slop-lab/dim-host-plugin-external-urls` on the selected host. The selected host's
private ingress configuration supplies available ingress choices; a project does
not need repository configuration or DNS provider credentials.

Open a workspace's External routes section, choose an ingress, and create a route
for its service port. OpenCode defaults to port 4096. The route form also supports
other ports, protocols, and named nested containers. Creating a route never
implicitly approves it: when approval is required, an operator must select
**Approve route**. Pending and revoked routes have no active browser link.
Read-only accounts can inspect available routes but cannot create, approve, or
revoke them.

Approved routes show their **Service URL** first and, when available, a separate
**Permanent URL**. The service address is never replaced by the permanent address.
Read-only accounts see the same approved addresses.

The Web feature delegates only fixed `external-url console invoke` operations to
a trusted configured controller. Every request carries the workspace's exact UUID;
the host verifies ownership and route authority. Operator credentials remain on
the host. Missing host integration produces a recoverable inline notice while
other workspace functions remain available.
