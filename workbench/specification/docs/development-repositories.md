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

For DIM's own Project, normal changes merge through a pull request into the
managed host's protected `development` branch. Those pull requests run the
source and managed-workspace gates. A non-draft pull request targeting its
protected `main` branch is the promotion boundary and additionally runs every
disposable-QEMU host-backend gate. Draft promotion pull requests do not reserve
those runners.

The reviewed self-Project manifest maps managed `main` to canonical
`development`. After a promotion PR merges, publish the exact candidate with:

```bash
dim repo publish dim dim
```

This mapping cannot update GitHub `main`; that branch remains the public
release boundary. Both managed `main` and `development` are declared as
protected refs in the same manifest, so workspace credentials cannot push
either branch directly. The current Gitea rules implement that provider-neutral
Project policy; they are not a Gitea-specific contract for contributors or
product repositories.

External changes can be imported with `dim repo fetch dim dim`. They appear as
managed `upstream/*` tracking branches and still require the normal review path
before changing protected development history.

After installing a revision that introduces or changes this policy, reconcile
the self Project once from the host:

```bash
dim repo apply dim --yes
dim repo protect dim dim
```

`apply` records the reviewed publish mapping without re-importing an unchanged
origin. `protect` idempotently reconciles the current managed-host rules. No
Gitea remote name, URL, or API operation is part of the contributor workflow;
DIM's repository and pull-request commands resolve the active provider.

Do not infer the active forge from an installed CLI or assume that a workspace
remote is GitHub. Development tooling should inspect the Git remote and select
the matching provider integration. A future managed-host replacement should
preserve this workflow without requiring DIM core, Project definitions, or
agent instructions to name Gitea.

Release preparation verifies the exact candidate commit in both locations
before publishing. See [Releasing](releasing.md) for that synchronization and
verification procedure.

Because the managed development host is not the canonical public issue or
source location, its local issue numbers must not appear in commit subjects or
PR titles that may later become public history. Use standalone descriptive
subjects; reference a managed-host issue in the development PR body when that
context is useful locally.
