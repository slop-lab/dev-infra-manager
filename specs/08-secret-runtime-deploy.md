# Secret Runtime Deployment

## Scope

This specification defines deployment of the secret-bearing runtime container from a reviewed Git ref.

The secret runtime deployment path is trusted-boundary behavior.

## Inputs

Deployment uses `secretRuntime` config:

- `repo`
- `approvedRef`
- `image`
- `containerName`
- `contextPath`
- `dockerfile`
- Optional `envFile`
- `publish`

## Plan

Given a temporary worktree path, the deployment plan is:

1. `git --git-dir <repoPath> worktree add --detach <worktree> <approvedRef>`
2. `sudo docker build --pull --tag <image> --file <dockerfile> <context>`
3. `sudo docker rm --force <containerName>` with failure allowed.
4. `sudo docker run --detach --name <containerName> --restart unless-stopped [--publish ...] [--env-file ...] <image>`
5. `git --git-dir <repoPath> worktree remove --force <worktree>`

`context` is `<worktree>/<contextPath>`.
`dockerfile` is `<context>/<dockerfile>`.

## Execution

`secret deploy` must:

1. Create a temporary directory under the host temp directory.
2. Execute the plan in order.
3. Track whether the Git worktree was added.
4. Remove the Git worktree in `finally` if deployment fails after worktree creation.
5. Remove the temporary directory in `finally`.
6. If `docker run` fails, best-effort remove the named container object that
   Docker may have left in `created` state.

Dry-run mode must print commands and avoid executing host mutations.

## Secret Handling

Secret values must not be stored in Git-managed config by this project.

If the secret runtime needs secrets:

- They should be provided through `secretRuntime.envFile`.
- The env file path must be outside agent-controlled workspaces.
- The env file itself is host-side trusted configuration.

## Invariants

- Deployment must use the configured approved ref.
- Deployment must not build from unreviewed agent workspace files.
- The previous container removal may fail without failing deployment.
- Any failure after worktree creation must attempt worktree cleanup.

## Failure Behavior

- Failure to resolve or check out the approved ref fails deployment.
- Docker build failure fails deployment.
- Docker run failure fails deployment.
- A Docker run failure triggers `sudo docker rm --force <containerName>` so a
  partial container does not block the next deployment.
- Previous container removal failure is allowed.
- Cleanup failures in the final fallback are best effort.

## Verification

Required verification:

- Unit test for planned commands.
- Smoke test that deploys from an approved managed Git ref.
- Health check for the example secret runtime.
