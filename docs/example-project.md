# Example: A Multi-repository Project

This walks through DIM end to end on a small but realistic Project: one root
infrastructure repository plus two additional repositories, a product repo
and a separate secret-bearing repo. It installs DIM, registers the three
repositories, creates a real workspace container, runs a project task, and
shows that the workspace can reach the other repositories on its own.

The repository contents below are placeholders sized for reading in one
sitting, not a real infrastructure or secrets setup. For the underlying
concepts (what a Project is, the `.dim` contract, capability profiles), see
[Project Workspaces](project-workspaces.md) and [Repository-backed
Workspaces](repo-workspaces.md).

This exact sequence is exercised by `scripts/example-project-smoke.sh`
(`just verify-example-project`) against a real Docker daemon and a real
managed Gitea instance. If you change the commands here, update that script
too — it is what keeps this page honest.

Before adopting DIM for real infrastructure, follow the mandatory [DIM
adoption and trust requirements](adoption.md).

## Prerequisites

- DIM installed and on `PATH` — see the [installer
  README](https://www.npmjs.com/package/@slop-lab/install-dim) or, for local
  development, [Setup](usage.md#setup).
- A working runtime backend (`just doctor` should report it ready).
- A managed Git service reachable at `$DIM_GIT_BASE_URL` (started for you by
  `dim create` the first time it's needed).

## 1. Install DIM

Pin an exact, reviewed version — never `latest`:

```bash
mise use -g 'npm:@slop-lab/install-dim@0.2.0'
dim install-cli
```

See the [installer README](https://www.npmjs.com/package/@slop-lab/install-dim)
for `npx`-based and direct-`PATH` alternatives.

## 2. The example repositories

Three tiny repositories make up the Project:

**`example-root`** (the required root repository) defines the workspace
environment and one task:

```text
example-root/
└── .dim/
    ├── docker-compose.yml
    └── entrypoint.sh
```

```yaml
# .dim/docker-compose.yml
services:
  dev:
    image: alpine:3.22
    command: ["sleep", "infinity"]
```

```sh
# .dim/entrypoint.sh
#!/usr/bin/env sh
set -eu
task="${1:?task is required}"
shift
case "$task" in
  hello) echo "hello from the example project" ;;
  *) echo "unknown task: $task" >&2; exit 2 ;;
esac
```

**`example-web`** (a product repository, unrelated to `.dim`):

```text
example-web/app.txt  -->  "hello from example-web"
```

**`example-secrets`** (a separate, more strictly reviewed repository for
secret-bearing environment code — DIM assigns it no special runtime role;
your own review policy does):

```text
example-secrets/env.txt  -->  "PLACEHOLDER_SECRET=not-a-real-secret"
```

Never commit real secret material to any Project repository, including this
one — see [Project Workspaces](project-workspaces.md#concepts).

Each is an ordinary Git repository with one commit. Create them however you
normally would (`git init`, add the files above, commit).

## 3. Register the Project and its repositories

```bash
dim project create example

dim repo create example root --root --ref main
dim x git -C ./example-root push "$(dim repo url-for-host example root)" main
dim repo protect example root

dim repo create example web
dim x git -C ./example-web push "$(dim repo url-for-host example web)" main
dim repo protect example web

dim repo create example secrets
dim x git -C ./example-secrets push "$(dim repo url-for-host example secrets)" main
dim repo protect example secrets
```

`dim x git` supplies managed Gitea credentials for this one push; run `dim
git setup` once instead if you'd rather your normal `git push` authenticate
directly. Each `repo create` only registers an alias local to this Project —
`web` and `secrets` don't need to be globally unique names.

## 4. Create the workspace

```bash
dim create example example-dev --backend runc --profile development
```

This claims the workspace, clones `example-root` inside it, and runs
`.dim/docker-compose.yml` — a real container now exists.

## 5. Confirm it's real

```bash
dim show example-dev --json
docker ps --filter "name=dim-ws-example-dev"
dim exec example-dev -- hostname
```

`show` reports `"phase": "ready"`, `docker ps` lists the running `dev`
service container, and `exec` runs a command inside it.

## 6. Run the project task

```bash
dim run example-dev hello
```

`run` dispatches through `.dim/entrypoint.sh` without repeating setup.

## 7. Reach the other repositories from inside the workspace

Only the root repository is cloned automatically. Everything else is
reachable through the managed Git service using the credentials `dim`
already exports into the workspace:

```bash
dim exec example-dev -- sh -c \
  'git clone "$DIM_GIT_BASE_URL/web.git" /tmp/web && cat /tmp/web/app.txt'
```

This prints `hello from example-web` — cloned from inside the container,
using `$DIM_GIT_BASE_URL` plus the `dim-git-askpass` helper `dim` installs
into the workspace. See [Multiple repositories](repo-workspaces.md#multiple-repositories)
for how project code is expected to use this in practice (usually from
`.dim/setup.sh` or a Compose service, not by hand).

## 8. Clean up

```bash
dim discard example-dev --yes
```

This stops the project's Compose services, then removes the workspace's
runtime, inner-Docker store, checkout, and journal. The `example` Project and
its three repositories are still registered on the managed Git service.
Remove just the local Project metadata with `dim project remove example`, or
delete the Project's Git organization and every repository in it with `dim
project purge example --yes` once nothing still needs them.
