# Example: A Multi-repository Project

This walks through DIM end to end on a small but realistic Project: one root
infrastructure repository plus two additional repositories, a product repo
and a separate secret-bearing repo. It installs DIM, registers the three
repositories, creates a real workspace container, runs `codex` and `claude`
inside a nested dev container that can itself create further containers,
shows that the trusted project-root controller can reach reviewed repositories,
and deploys the secret-bearing service inside the project-root workspace
container but outside the agent's `dev` container and Docker daemon. This is DIM's actual
purpose: a persistent, isolated container where a coding agent can work
without ever touching secrets or protected infrastructure directly, not a
toy.

`repos/` in this directory contains the actual repository skeletons used
below — not a code listing, real files. Copy any of them directly as a
starting point for your own project:

```text
examples/multi-repo-project/repos/
├── root/            the required root repository
│   └── .dim/
│       ├── controller.sh
│       ├── docker-compose.yml
│       └── entrypoint.sh
├── web/              a product repository, unrelated to .dim
│   └── app.txt
└── secrets/          a separate, more strictly reviewed repository
    ├── Dockerfile
    └── server.mjs
```

They're placeholders sized for reading in one sitting, not real
infrastructure. `secrets/` builds a minimal service that takes a secret
value as configuration and never returns it — even in this example, never
commit the actual secret value itself to any Project repository, including
this one; see [Project Workspaces](../../docs/project-workspaces.md#concepts).

For the underlying concepts (what a Project is, the `.dim` contract,
capability profiles), see [Project Workspaces](../../docs/project-workspaces.md)
and [Repository-backed Workspaces](../../docs/repo-workspaces.md).

This exact sequence is exercised by `scripts/example-project-smoke.sh`
(`just verify-example-multi-repo-project`, from the DIM repository root)
against a real Docker daemon and a real managed Gitea instance. If you change the
repository skeletons or commands here, update that script too — it is what
keeps this page honest.

The smoke script stays in DIM's top-level `scripts/` directory because it
builds and locally installs unpublished DIM packages, manages a temporary npm
registry and Gitea organization, and performs host-side cleanup. It copies
each directory under this example's `repos/` into a fresh temporary location,
initializes three real Git repositories, and creates the workspace container
from those materialized repositories. No pre-existing example workspace is
reused.

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

dim repo create example root --root --ref main --protect main
dim x git -C ./example-root push "$(dim repo url-for-host example root)" main
dim repo protect example root

dim repo create example web --protect main
dim x git -C ./example-web push "$(dim repo url-for-host example web)" main
dim repo protect example web

dim repo create example secrets --protect main
dim x git -C ./example-secrets push "$(dim repo url-for-host example secrets)" main
dim repo protect example secrets
```

`dim x git` supplies managed Gitea credentials for this one push; run `dim
git setup` once instead if you'd rather your normal `git push` authenticate
directly. Each `repo create` only registers an alias local to this Project —
`web` and `secrets` don't need to be globally unique names.

`--protect` belongs on `repo create`/`repo import`, not `repo protect`: an
empty repository has no branch to protect yet, so `create` only records the
policy, and `protect` applies it once the branch exists. Skipping `--protect`
at `create` time is a real footgun — the later `repo protect` call still
reports success, having protected nothing.

## 4. Create the workspace

```bash
dim create example example-dev --backend runc --profile development
```

This claims the workspace, clones `example-root` inside its trusted
project-root container, and runs `.dim/docker-compose.yml`. Its `dev` service
installs `codex` and `claude` and starts an independent nested Docker daemon,
so agents can create further containers without access to the project-root
controller's daemon.

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

## 7. Run a coding agent in the dev container

```bash
dim run example-dev codex -- "describe this repository in one sentence"
dim run example-dev claude -- "describe this repository in one sentence"
```

The `codex` and `claude` tasks exec into the already-running `dev` service
and run the agent with `--dangerously-bypass-approvals-and-sandbox` /
`--dangerously-skip-permissions` — appropriate here because `dev` is itself
an isolated, disposable container, not your host. Always put agent arguments
after `--`: `dim run` forwards unrecognized flags to `dim` itself otherwise,
so `dim run example-dev codex --version` (no `--`) prints `dim`'s own
version instead of reaching `codex` at all.

## 8. Create a nested container from inside the dev container

```bash
dim exec example-dev -- \
  docker compose --file .dim/docker-compose.yml exec -T dev \
  docker run --rm hello-world
```

`dev` has its own Docker-in-Docker daemon. Containers it creates are nested
under the agent boundary and are neither host containers nor siblings managed
by the project-root controller. This lets an agent build images, run tests,
and start dependencies without being able to inspect or control a
secret-bearing container.

## 9. Reach the other repositories from inside the workspace

Only the root repository is cloned automatically. The trusted project-root
controller can fetch other reviewed repositories through the managed Git
service using the credentials DIM exports at that boundary:

```bash
dim exec example-dev -- sh -c \
  'git clone "$DIM_GIT_BASE_URL/web.git" /tmp/web && cat /tmp/web/app.txt'
```

This prints `hello from example-web` — cloned by the project-root controller,
using `$DIM_GIT_BASE_URL` plus the `dim-git-askpass` helper `dim` installs
into the workspace. See [Multiple
repositories](../../docs/repo-workspaces.md#multiple-repositories) for how
project code is expected to use this in practice (usually from
`.dim/setup.sh` or a Compose service, not by hand).

## 10. Deploy the secret-bearing service beside the agent container

The `secrets` repository is registered above like any other, but its container
is deliberately **not** part of the agent-facing `.dim/docker-compose.yml`.
The reviewed `.dim/controller.sh` runs in the project-root workspace
container, fetches the approved `secrets` ref, and uses the project-root
nested Docker daemon to create the service. It is a sibling of `dev`, not a
container inside `dev`, and `dev` has a different Docker daemon (see [Trust
Boundaries](../../specs/02-boundaries-and-trust.md#secret-bearing-runtime-boundary)).
The agent therefore cannot inspect, stop, or replace it.

```bash
dim exec example-dev -- \
  env EXAMPLE_SECRET=not-a-real-secret sh .dim/controller.sh deploy-secret
dim exec example-dev -- sh .dim/controller.sh secret-health
```

This prints `{"ok":true,"secretConfigured":true}` — the service is real and
has the secret, but never returns it. These `dim exec` calls represent a
trusted operator invoking the controller boundary; they are not agent tasks
exposed through `.dim/entrypoint.sh`. Confirm the `dev` container received
neither the secret nor control of the service:

```bash
dim exec example-dev -- docker compose -f .dim/docker-compose.yml \
  exec -T dev sh -c 'env | grep -c EXAMPLE_SECRET || true'
dim exec example-dev -- docker compose -f .dim/docker-compose.yml \
  exec -T dev docker ps --format '{{.Names}}'
```

The first command prints `0`, and the second does not list
`example-secret-service`. The project-root controller receives the secret only
for deployment; the agent environment does not.

Tear the example service down explicitly when done:

```bash
dim exec example-dev -- sh .dim/controller.sh remove-secret
```

## 11. Clean up

```bash
dim discard example-dev --yes
```

This stops the project's Compose services, then removes the workspace's
runtime, inner-Docker store, checkout, and journal. The `example` Project and
its three repositories are still registered on the managed Git service.
Remove just the local Project metadata with `dim project remove example`, or
delete the Project's Git organization and every repository in it with `dim
project purge example --yes` once nothing still needs them.
