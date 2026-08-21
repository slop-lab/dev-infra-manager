# Single-Repository Project

This is the default DIM Project shape: one application repository, no
`.dim/repos.yml`, no secret-bearing service, and no mandatory human review of
agent changes. It demonstrates persistent workspace state, explicit resource
limits, a Project-owned unprivileged agent container, its private rootless
DinD sidecar, lifecycle hooks, and an optional controlled external URL.

Because this example assumes the repository contains no protected or
secret-bearing authority, it deliberately does **not** configure branch
protection. The agent may push directly to `main`. Add `--protect main` when a
Project's `.dim` code, deployment authority, or policy requires review.

## Try it

Install the external URL plugin if you want the optional URL steps:

```bash
dim install-plugin '@slop-lab/dim-plugin-external-urls@0.8.0'
```

Materialize and register the one repository:

```bash
bash create-repository.bash
bash register-project.bash
```

The registration command is intentionally small:

```bash
dim project create single-app \
  --root app \
  --url single-repository/app \
  --ref main
```

There is no `.dim/repos.yml` because there are no additional repositories.
Create a bounded workspace; the repository's idempotent `.dim/setup.sh`
starts two Project-owned services:

```text
resource-bounded DIM workspace
└── Project runtime
    ├── agent       unprivileged; repository checkout and HTTP app
    └── agent-dind  private rootless Docker daemon
```

The agent receives neither the host Docker socket nor the Project runtime
socket. Its `DOCKER_HOST` reaches only `agent-dind`, so coding tools can create
nested containers without controlling sibling Project services.

Reviewed setup code also creates a deny-by-default agent controller proxy. The
agent receives only its derived socket, not the workspace grant or original
controller socket. This example allows one exact operation: asynchronously
restart the authenticated workspace.

```bash
dim workspace run single-dev bash -- -lc '
  curl --fail --silent --unix-socket "$DIM_CONTROLLER_SOCKET" \
    --request POST http://dim-controller/api/workspace/restart
'
```

The request cannot name or restart another workspace. The host controller
derives the target from the scoped grant held by the trusted proxy.

```bash
dim workspace create single-app single-dev \
  --cpus 2 --memory 2g --processes 512
dim workspace run single-dev bash -- -lc 'curl --fail http://127.0.0.1:3000'
dim workspace run single-dev codex
dim workspace run single-dev bash -- -lc 'docker run --rm hello-world'
```

The Project also owns a simple streaming backup contract for the agent home.
Backup data uses stdout and restore data uses stdin; diagnostics remain on
stderr, so DIM does not need to understand the archive format. The task stops
the agent for consistency and gives a networkless temporary container only the
named home volume (read-only for backup and read-write for restore):

```bash
dim workspace run single-dev backup >single-dev-home.tar.gz
dim workspace run single-dev restore <single-dev-home.tar.gz
```

An agent running directly in this no-secret workspace receives the
Project-scoped Git writer and may push `main` because this example configured
no protected patterns.

Configure a host ingress and request a URL for the `agent` service:

```bash
bash configure-ingress.bash
dim external-url request --workspace single-dev \
  --ingress local-http --container agent --port 3000
dim external-url list --workspace single-dev
```

Revoke the returned URL with `dim external-url revoke URL_ID`, then discard
the workspace:

```bash
dim workspace discard single-dev --yes
```

Agent commits are not automatically reflected in an already-running
workspace yet. A future workspace-scoped update API can add that workflow
without changing this single-repository Project shape.

Verify the complete example with:

```bash
just verify example current-installed auto single-repository
```

When the Docker CLI talks to a daemon in a sibling DinD container, the daemon
must see DIM's bind sources at the same absolute paths. Point the verification
work root at a directory mounted into both containers, for example:

```bash
DIM_EXAMPLE_WORK_ROOT=/mnt/workspace-shared-dind \
  just verify example current-installed auto single-repository
```
