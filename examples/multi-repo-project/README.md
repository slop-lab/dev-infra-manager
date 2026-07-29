# Example: A Multi-repository Project

This example has three reviewed Git repositories:

```text
repos/
├── root/       trusted Project lifecycle and Compose definition
├── web/        ordinary product source
└── secrets/    source for a secret-bearing HTTP service
```

The short scripts beside this README contain the otherwise repetitive Git and
DIM commands. Read them before running them; they are intentionally small.
For the trust model, see [Trust Boundaries](../../specs/02-boundaries-and-trust.md).

## Try it

Install DIM, then check the configured default runtime:

```bash
dim doctor
```

From this directory:

```bash
bash create-repositories.bash
bash register-project.bash
dim create example example-dev
```

`dim create` uses the runtime backend recorded during installation and uses
no Compose profiles unless `--profile` is supplied.

Open an interactive shell or coding agent in `dev`:

```bash
dim run example-dev bash
dim run example-dev codex
dim run example-dev claude
```

Arguments can follow `--`, for example:

```bash
dim run example-dev bash -- -lc 'git status'
dim run example-dev codex -- 'describe this repository'
```

Discard the workspace when finished:

```bash
dim discard example-dev --yes
```

## What gets created

The root repository is cloned into the trusted project-root container. Its
`.dim/setup.sh` reads the host Git author through DIM's narrow host-input API,
then starts [.dim/docker-compose.yml](repos/root/.dim/docker-compose.yml).

```text
host
└── project-root container (trusted controller, root Docker daemon)
    ├── dev container (untrusted agent, its own Docker daemon)
    │   └── containers created by dev
    └── secret container (root Docker daemon, raw secret)
```

The `dev` container has Docker CLI access only to its own DinD daemon. It does
not receive the project-root Docker socket, so `docker ps` there cannot see or
control the sibling `secret` container.

Only the root repository is cloned automatically. Trusted root lifecycle code
can clone `web` or `secrets` using the managed Project Git URL. The registration
script demonstrates the host form:

```bash
dim repo url example web
```

Use `dim repo url --workspace example web` when lifecycle code needs the
workspace-reachable form.

## Secret-bearing service

The normal setup starts only `dev`. A trusted operator supplies the secret:

```bash
EXAMPLE_SECRET=not-a-real-secret bash deploy-secret.bash
```

[ops/secret-service.sh](repos/root/ops/secret-service.sh) then clones the approved
`secrets` repository and starts the Compose `secret` service on the
project-root Docker daemon. The deployment passes the secret into that
container's environment without adding it to Project state, repository files,
or the dev container.

The trusted project-root container can administer or inspect it with Compose:

```bash
dim exec example-dev -- \
  docker compose -f .dim/docker-compose.yml exec -T secret \
  wget -qO- http://127.0.0.1:7099/healthz
```

The dev container has no root Docker access. It can only call the constrained
HTTP interface exposed by the service:

```bash
dim run example-dev bash -- \
  -lc 'wget -qO- http://secret:7099/healthz'
```

The response confirms configuration without returning the secret:

```json
{"ok":true,"secretConfigured":true}
```

Remove the secret-bearing service from the trusted root boundary:

```bash
dim exec example-dev -- sh ops/secret-service.sh remove-secret
```

Never commit a real secret to any Project repository. Review the pinned root
and secret-bearing revisions, Dockerfiles, dependencies, and deployment code
before using this pattern with real credentials.

For readability, this example deploys the protected `main` branch of
`secrets`. A production Project should replace that branch selection in
`ops/secret-service.sh` with its reviewed immutable revision.

## Development verification

DIM contributors can run the complete materialized-repository smoke test:

```bash
just verify-example-multi-repo-project
```

`just` is used only for this repository's development workflow; installed
users use `dim doctor` and the commands above.
