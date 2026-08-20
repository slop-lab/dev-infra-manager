# DIM Development Repositories

The public GitHub repository is DIM's canonical source repository. Public
history, releases, and downstream source links use GitHub.

DIM itself is normally developed through DIM. A self-development Project
imports the canonical source into the Project's DIM-managed Git host, and
workspaces push proposed branches there for isolated CI and review. The current
built-in managed host and CI coordinator are Gitea and Gitea Actions, but
Gitea is an implementation backend rather than part of the long-term Project
or contributor contract.

This gives the two repository locations different roles:

- GitHub is the canonical public source and release location.
- The active DIM-managed Git host is the preferred development and review
  location when working inside DIM.

Do not infer the active forge from an installed CLI or assume that a workspace
remote is GitHub. Development tooling should inspect the Git remote and select
the matching provider integration. A future managed-host replacement should
preserve this workflow without requiring DIM core, Project definitions, or
agent instructions to name Gitea.

Release preparation verifies the exact candidate commit in both locations
before publishing. See [Releasing](releasing.md) for that synchronization and
verification procedure.
