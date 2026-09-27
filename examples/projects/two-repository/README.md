# Two-Repository Project

This is a small DIM template for an ordinary application that benefits from a
persistent Linux sandbox without needing the extra boundaries demonstrated by
the multi-repository example. It uses exactly two repository aliases:

```text
repos/
├── root/    reusable DIM lifecycle and repository manifest
└── app/     ordinary application source
```

Only `root` is a template. Copy it into a dedicated repository, replace the
two URLs in [`.dim/repos.yml`](repos/root/.dim/repos.yml), and keep using your
application repository normally. The `app` repository does not need a `.dim`
directory or DIM-specific source files.

The root `main` branch is protected because it owns trusted lifecycle and
container policy. The ordinary app remains unprotected so its child runtime
can use the managed Project writer normally.

## Try it

Materialize the two fixtures as local Git repositories and register them:

```bash
bash create-repositories.bash
bash register-project.bash
```

The registration command imports the root manifest and applies both aliases:

```bash
dim project create two-repository \
  --bootstrap-git-url two-repository-repositories/root \
  --bootstrap-git-ref main \
  --apply-repos
```

Create a workspace and run a command from the ordinary app checkout:

```bash
dim workspace create two-repository two-repository-dev
dim workspace run two-repository-dev app -- sh hello.bash
```

The root setup reads the app's ready runtime-manifest entry, fetches its exact
immutable commit with system/global Git configuration and hooks disabled, and
atomically publishes the checkout under the persistent Project root. A full
`refs/heads/` ref becomes a local branch; other refs are checked out detached.
Existing Git checkouts are agent-owned and are never passed to trusted Git.
Restarting reconciles the child service without replacing local app work:

```bash
dim workspace restart two-repository-dev
dim workspace run two-repository-dev app -- sh hello.bash
```

App commands run only in a minimal Ubuntu child container as the workspace's
nonroot UID and GID, with all Linux capabilities dropped and privilege
escalation disabled. The child mounts only the app checkout at `/workspace`
and its persistent home. It receives managed Git credentials and author
identity, but no root checkout, Docker socket, DIM controller socket or grant,
host device, sudo, nested Docker daemon, secret, external URL, or
coding-agent-provider setup. Argument, stream, exit-status, and working-directory
behavior pass through the fixed `app -- ...` task mapping.

Discard the persistent workspace explicitly when the work is finished. The
root teardown removes only this template's Compose service, network, and home
volume:

```bash
dim workspace discard two-repository-dev --yes
```

DIM contributors can verify repository materialization and the complete
create, command, restart, and discard journey with:

```bash
just verify example current-installed auto two-repository
```
