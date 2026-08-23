# Full development flow

This reference Project combines the DIM features that normally belong in one
long-lived development environment:

- a protected root repository plus reviewed `web` and `secrets` repositories;
- a persistent, unprivileged agent home and private rootless Docker daemon;
- host-provided Git author identity and constrained managed-Git credentials;
- an agent controller proxy that permits only an asynchronous self-restart;
- an optional `documentation` Compose profile;
- Project-owned `backup`, `restore`, `bash`, `codex`, and `claude` tasks; and
- a trusted, separately deployed secret-bearing service outside the agent's
  private container daemon.

It intentionally contains no DIM CI-runner, registry-cache, failure-injection,
or provider-specific configuration. Those are host or verification concerns.

## Create and register

```bash
bash examples/projects/full-development-flow/create-repositories.bash \
  "$PWD/full-development-repositories"

bash examples/projects/full-development-flow/register-project.bash \
  full-development "$PWD/full-development-repositories"
```

The generated root manifest protects `main`. Review changes into the managed
root before restarting or updating a workspace.

## Work persistently

```bash
dim workspace create full-development full-dev \
  --profile documentation \
  --cpus 4 --memory 8g --processes 2048

dim workspace run full-dev bash
dim workspace run full-dev codex
dim workspace stop full-dev
dim workspace start full-dev
```

The agent can use its private Docker daemon but cannot access a host Docker
socket or the trusted secret service's raw environment.

## Backup before recreation

```bash
dim workspace run full-dev backup >full-dev-home.tar.gz
gzip -t full-dev-home.tar.gz

dim workspace discard full-dev --yes
dim workspace create full-development full-dev --profile documentation
dim workspace run full-dev restore <full-dev-home.tar.gz
```

`backup` and `restore` stream only the Project-owned agent-home volume. Git
work must be committed and pushed separately before discarding a workspace.

## Trusted deployment

After reviewing the root and `secrets` repositories, a trusted host may deploy
the secret-bearing service beside the Project-owned environment:

```bash
EXAMPLE_SECRET=replace-me \
  bash examples/projects/full-development-flow/deploy-secret.bash full-dev
```

See `scripts/stateful-development-flow-smoke.bash` for the disposable
end-to-end release journey. It materializes this example and injects failures
only into its temporary copy.
