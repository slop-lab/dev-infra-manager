# Feature example: managed CI runner

This example creates one minimal DIM Project with `root` and `app`
repositories. Its single organization-scoped runner can execute
pull-request checks from either repository. The runner is outside every
development workspace and selects jobs through the provider-neutral `dim`
label.

## Try it

Install DIM and Sysbox, then run from this directory:

```bash
bash create-repository.bash
bash register-project.bash
dim ci runner enable ci-runner-example
dim ci runner status ci-runner-example
```

The non-root `app` repository contains
[`.gitea/workflows/verify.yml`](repos/app/.gitea/workflows/verify.yml). Open a
pull request against its `main` branch; the Project runner will execute the
`verify` job in a disposable job container:

```yaml
jobs:
  verify:
    runs-on: dim
```

The `dim` label is the stable DIM contract. Although this first coordinator
adapter uses managed Gitea, Project scripts and resource settings do not need
to name Gitea.

The example uses the configured runner defaults. To override them only for
this Project:

```bash
dim ci runner enable ci-runner-example \
  --cpus 2 --memory 4g --pids-limit 1024
```

Remove the runner and its registration data when finished:

```bash
dim ci runner disable ci-runner-example --yes
```

## Development verification

DIM contributors can materialize both repositories, create an actual pull
request in the non-root `app` repository, and wait for the workflow to
succeed:

```bash
just verify-example current-installed auto ci-runner
just verify-example sysbox use ci-runner
```

This proves that organization registration makes one Project runner available
outside the root repository. The smoke test also checks that the runner uses
`sysbox-runc`, receives its declared Docker cgroup limits, remains
unprivileged, and does not mount the host Docker socket.
