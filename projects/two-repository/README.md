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

Neither repository is branch-protected in this example. Add reviewed
protection when the application or lifecycle needs it; the larger
[`multi-repository`](../multi-repository/README.md) example demonstrates that
shape.

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

The root setup clones `app` once into the persistent workspace checkout.
Restarting reconciles lifecycle setup without replacing local app work:

```bash
dim workspace restart two-repository-dev
dim workspace run two-repository-dev app -- sh hello.bash
```

This minimal template runs app commands directly in the isolated workspace
container. It intentionally has no nested agent container, private Docker
daemon, secrets, external URL, or coding-agent-provider setup. Use the other
Project examples when those boundaries or capabilities are required.

Discard the persistent workspace explicitly when the work is finished:

```bash
dim workspace discard two-repository-dev --yes
```

DIM contributors can verify repository materialization and the complete
create, command, restart, and discard journey with:

```bash
just verify example current-installed auto two-repository
```
