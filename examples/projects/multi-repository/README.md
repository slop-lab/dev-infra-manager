# Multi-Repository Project

This is the expanded DIM Project shape for cases that need independent
repository or secret-bearing review boundaries. Start with the
[`single-repository`](../single-repository/README.md) example unless those
boundaries are useful.

```text
repos/
├── root/       reviewed Project lifecycle and agent definition
├── web/        ordinary application source
└── secrets/    reviewed source for a secret-bearing service
```

The committed [`repos.yml`](repos/root/.dim/repos.yml) defines the complete
reviewed repository set. The root repository owns Project lifecycle and task
dispatch, while all three repositories remain part of the same reviewable
Project.

Feature-specific examples live under [`../../features`](../../features).

## Try it

Install DIM, then from this directory:

```bash
bash create-repositories.bash
bash register-project.bash
dim workspace create example example-dev
```

The registration script runs:

```bash
dim project create example \
  --url example-repositories/root \
  --ref main \
  --no-apply-repos
dim repo apply example --yes
```

The example deliberately skips the discovered set and then applies it from
the managed root to verify that declining `Apply it?` never requires another
local clone. Normal unattended setup can use `--apply-repos` directly.

Only the root repository is cloned automatically into the trusted workspace.
Reviewed lifecycle code can reach the other managed repositories through
their Project URLs:

```bash
dim repo url example web
dim repo url --workspace example secrets
```

Run a shell or coding agent:

```bash
dim workspace run example-dev bash
dim workspace run example-dev codex
dim workspace run example-dev claude
```

Arguments can follow `--`:

```bash
dim workspace run example-dev bash -- -lc 'git status'
```

Export or restore only the Project-owned agent home as a gzip tar stream:

```bash
dim workspace run example-dev backup >example-dev-home.tar.gz
dim workspace run example-dev restore <example-dev-home.tar.gz
```

The Project defines this format and task mapping; DIM only streams stdin,
stdout, stderr, and the task exit status.

## Trust and container boundaries

The trusted root checkout owns `.dim/setup.sh`, Compose configuration, and the
fixed `.dim/entrypoint.sh` task mapping. Setup obtains the host Git author
through DIM's narrow host-input API and starts the Project-owned `agent`
service.

```text
host-side DIM runtime
└── trusted workspace container
    └── private Project Docker daemon
        ├── unprivileged agent container
        ├── privileged rootless-DinD sidecar
        └── secret container built from the managed secrets repository
```

The agent receives the host author, managed Project Git credentials, and the
root checkout. It does not receive the host Docker socket or the trusted
workspace Docker socket. The privileged sidecar runs a rootless Docker daemon
inside the workspace's existing resource and isolation boundary; the agent
reaches it over the private Compose network.

The agent and DinD sidecar share only the named volume mounted at
`/mnt/workspace-shared-dind`. Bind-mounted nested workloads must use a source
below that path so the source has the same meaning from both containers.
Because the unprivileged agent and rootless DinD may have different host UIDs,
the shared volume root is a sticky writable directory. A bind-source directory
that both sides must modify must grant write access to both identities, for
example `mkdir -m 0777 /mnt/workspace-shared-dind/my-bind`.

DIM core does not know that this service is an agent. The root repository owns
its image, service lifecycle, resource choices, and fixed task mapping through
the ordinary setup, Compose, entrypoint, and teardown contracts.

## Secret-bearing service

A trusted operator can deploy the reviewed source from the managed `secrets`
repository while supplying the secret out of band:

```bash
EXAMPLE_SECRET=not-a-real-secret bash deploy-secret.bash
```

Check it from the trusted workspace:

```bash
dim workspace exec example-dev -- sh ops/secret-service.sh secret-health
```

Or through its constrained HTTP interface from the agent:

```bash
dim workspace run example-dev bash -- \
  -lc 'wget -qO- http://secret:7099/healthz'
```

The health response reports only whether a secret was configured. The agent's
private Docker daemon cannot list the trusted workspace's secret container,
and the raw secret is not included in the agent environment. Never commit a
real secret.

Remove the service and workspace:

```bash
dim workspace exec example-dev -- sh ops/secret-service.sh remove-secret
dim workspace discard example-dev --yes
```

## Development verification

DIM contributors can materialize all three repositories and verify this exact
example:

```bash
just verify example current-installed auto multi-repository
just verify example runc use multi-repository
```
