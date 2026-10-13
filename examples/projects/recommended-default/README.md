# Recommended Default Workspace

This is the smallest DIM workspace environment. The repository has no `.dim`
directory, so DIM selects the recommended host-side unprivileged Sysbox agent.
DIM persists the agent's home, checkout, and private Docker data in three named
volumes. It does not install or authenticate OpenCode, Codex, Claude Code, or
another agent provider.

## Create a zero-`.dim` repository

From an empty working directory:

```bash
mkdir repository
git -C repository init --initial-branch=main
printf '# Recommended workspace demo\n' >repository/README.md
git -C repository add README.md
git -C repository \
  -c user.name='DIM Example' \
  -c user.email='dim-example@example.invalid' \
  commit -m 'Initialize repository'
test ! -e repository/.dim
```

Register it and create a bounded workspace:

```bash
dim project create recommended-demo \
  --root root \
  --bootstrap-git-url "$PWD/repository" \
  --bootstrap-git-ref main \
  --protect main
dim workspace create recommended-demo recommended-dev \
  --cpus 4 --memory 4g --pids 1024
```

The recorded limits are one combined budget. This example assigns 1 CPU,
1 GiB, and 256 PIDs to the trusted outer container, and the exact remainder of
3 CPUs, 3 GiB, and 768 PIDs to the agent. Each container's swap limit equals
its memory limit.

Creation reports ready only after the agent and checkout are ready. A failed
initial clone, fetch, checkout, or publication adopts no partial repository.
The retry recovers or safely replaces only the owned stage and seeds the exact
selected protected-root commit into the empty checkout once.

## Run commands

```bash
dim workspace run recommended-dev shell
dim workspace run recommended-dev exec -- git status --short
dim workspace run recommended-dev custom -- sh -lc 'printf "custom is a direct command\n"'
dim workspace exec recommended-dev -- git log -1 --oneline
```

`shell` accepts no arguments. `exec` and `custom` require a command. In the
recommended environment, both `run` operations and `workspace exec` execute in
the agent at `/workspace`; `custom` does not discover a hook. These built-ins
do not install tools, log in to a provider, or run Project-specific setup.

When the protected root advances, `setup`, `start`, `restart`, or `update` may
refresh the immutable lifecycle selection but never resets the mutable
checkout. Its `HEAD`, index, tracked changes, staged changes, untracked and
ignored files, and local commits stay unchanged. DIM prints a notice, completes
setup, and keeps the normal agent commands usable.

Adopt the updated product source explicitly after reviewing it:

```bash
dim workspace update recommended-dev
dim workspace run recommended-dev exec -- git fetch origin
dim workspace run recommended-dev exec -- \
  git log --oneline --decorate HEAD..origin/main
dim workspace run recommended-dev exec -- git rebase origin/main
# Or, after review, use: git merge origin/main
```

A product root-code change does not require a fresh workspace. Preserve,
discard, and recreate only when changing between recommended and custom
environments.

## Preserve or discard

Stop/start keeps the same workspace and all three volumes:

```bash
dim workspace stop recommended-dev
dim workspace start recommended-dev
```

Recommended `discard --keep-volume` is rejected before any mutation. To retain
all data, leave the workspace intact. Before a full discard or environment-mode
change, explicitly commit and push the checkout and copy or back up any needed
home or private-Docker data through commands appropriate to that data. DIM does
not provide an automatic cross-workspace restore for these identity-bound
volumes.

```bash
dim workspace discard recommended-dev --yes
```

## Choose custom behavior when needed

Keep the zero-`.dim` recommended environment when the built-in agent and
commands meet the Project's needs. Choose custom only for actual reviewed
behavior, such as `.dim/setup.sh`, `.dim/entrypoint.sh`,
`.dim/docker-compose.yml`, or `.dim/teardown.sh`. Those files let the Project
own setup, task dispatch, services, agent topology, and cleanup. They don't have
to use a shared DinD or agent format.

The [single-repository](../single-repository/README.md) and
[two-repository](../two-repository/README.md) examples show real custom
lifecycle implementations. `.dim/environment.yml` is an obsolete, unsupported
format and is rejected.

Changing an existing workspace between recommended and custom is not an
in-place operation. Preserve needed data, fully discard, and create a fresh
workspace.
