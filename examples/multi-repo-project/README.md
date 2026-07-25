# Example: A Multi-repository Project

This walks through DIM end to end on a small but realistic Project: one root
infrastructure repository plus two additional repositories, a product repo
and a separate secret-bearing repo. It installs DIM, registers the three
repositories, creates a real workspace container, runs a project task, and
shows that the workspace can reach the other repositories on its own.

`repos/` in this directory contains the actual repository skeletons used
below — not a code listing, real files. Copy any of them directly as a
starting point for your own project:

```text
examples/multi-repo-project/repos/
├── root/            the required root repository
│   └── .dim/
│       ├── docker-compose.yml
│       └── entrypoint.sh
├── web/              a product repository, unrelated to .dim
│   └── app.txt
└── secrets/          a separate, more strictly reviewed repository
    └── env.txt
```

They're placeholders sized for reading in one sitting, not a real
infrastructure or secrets setup. Never commit real secret material to any
Project repository, including one modeled after `secrets/` here — see
[Project Workspaces](../../docs/project-workspaces.md#concepts).

For the underlying concepts (what a Project is, the `.dim` contract,
capability profiles), see [Project Workspaces](../../docs/project-workspaces.md)
and [Repository-backed Workspaces](../../docs/repo-workspaces.md).

This exact sequence is exercised by `scripts/example-project-smoke.sh`
(`just verify-example-project`, from the repository root) against a real
Docker daemon and a real managed Gitea instance. If you change the
repository skeletons or commands here, update that script too — it is what
keeps this page honest.

Before adopting DIM for real infrastructure, follow the mandatory [DIM
adoption and trust requirements](../../docs/adoption.md).

## Prerequisites

- DIM installed and on `PATH` — see the [installer
  README](https://www.npmjs.com/package/@slop-lab/install-dim) or, for local
  development, [Setup](../../docs/usage.md#setup).
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

## 2. Create the example repositories

Copy each repository skeleton out and make it a real Git repository with one
commit:

```bash
for name in root web secrets; do
  cp -r "examples/multi-repo-project/repos/$name" "./example-$name"
  git init --initial-branch=main "./example-$name"
  git -C "./example-$name" add -A
  git -C "./example-$name" commit -m "initial example-$name"
done
```

Each is otherwise an ordinary Git repository — create yours however you
normally would.

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
docker ps --filter "name=$(dim show example-dev --json | jq -r .containerName)"
dim exec example-dev -- hostname
```

`show` reports `"phase": "ready"` and the workspace's actual `containerName`
— read it from there rather than guessing a name; it's an implementation
detail `dim` can change. `docker ps` then confirms it's a real, running
container, and `exec` runs a command inside it.

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
into the workspace. See [Multiple
repositories](../../docs/repo-workspaces.md#multiple-repositories) for how
project code is expected to use this in practice (usually from
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
