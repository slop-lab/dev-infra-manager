# Adoption and cutover

DIM is pre-stable and executes reviewed code at a host trust boundary. Review
and pin the exact release, root policy, lifecycle files, images, and private
configuration before installation.

Native-only cutover is contraction, not migration:

1. Keep the old installation intact.
2. Use its exact pinned prior release to stop services and export declared user
   data.
3. Validate the export outside DIM state.
4. Install fresh native services and create fresh Projects/workspaces.
5. Restore only declared user data through reviewed lifecycle behavior.
6. Dispose of old containers, volumes, remotes, and credentials only through a
   separate explicit operator action.

DIM does not scan for, adopt, convert, rename, or delete predecessor state.
Never copy provider state, runtime stores, grants, sockets, credentials,
approval records, or service databases into native state.
