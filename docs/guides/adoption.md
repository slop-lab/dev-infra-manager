# Adoption and data preservation

DIM is pre-stable. The installer facade is preserved, while other source,
configuration and state contracts can change intentionally. Installing a new
package is not permission to adopt or delete incompatible runtime resources.

Before replacing an incompatible installation:

1. Keep the exact prior release available.
2. Export needed checkout, home and other user data with that release's tools.
3. Store and validate the export outside DIM state and runtime volumes.
4. Install the selected package set and create fresh workspaces.
5. Restore declared user data explicitly.
6. Remove old resources only through a separate explicit discard operation.

Ordinary Git workspaces require no native Project or control-plane deployment.
Select managed capabilities separately when they are useful. Base installation
checks base-owned workspace records; it does not traverse or validate unrelated
optional integration state. Each integration owns its own parser and lifecycle.

Do not import grants, sockets, runtime identity, approvals or service credentials
as if they were workspace data. The architecture rework does not implement a
cross-version state converter or silently recover an empty checkout when an
initialized volume is missing.
