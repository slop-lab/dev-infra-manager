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

During repository extraction, each DIM component uses `main` in its own
managed Project repository. The reviewed connection imports that branch from
the archive's `dev/<alias>` and publishes it back to the same external branch.
The archive repository's
`development` and `main` gates remain in use until their CI policies are moved
to the final canonical repositories.

Only `root/main` and `development/main` are protected in the self Project:
those repositories control the trusted outer lifecycle and common inner
development environment. Component source, paired tests, plugins, examples,
verification, and specification repositories intentionally leave managed
`main` agent-writable. External publication is still host-side authority and
is not granted by an unprotected managed branch. Publish every current managed
candidate with:

```bash
dim repo publish dim
```

These mappings cannot update GitHub `main`; that branch remains the public
release boundary. Workspace credentials cannot publish externally. The
current Gitea rules implement the two protected managed refs; they are not a
Gitea-specific contract for contributors or product repositories.

External changes can be imported per repository, for example with
`dim repo fetch dim core`. They appear as
managed `upstream/*` tracking branches and still require the normal review path
before changing managed development history.

Create the split self Project directly from the archive root branch:

```bash
dim project create dim \
  --url https://github.com/slop-lab/dev-infra-manager.git \
  --ref dev/root
```

Because every entry shares the bootstrap archive origin, this creates all
managed repositories without another apply flag. Their import, publish, and
two protected-branch policies are applied from reviewed root content. No Gitea
remote name, URL, or API operation is part of the contributor workflow; DIM's
repository and pull-request commands resolve the active provider.

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
