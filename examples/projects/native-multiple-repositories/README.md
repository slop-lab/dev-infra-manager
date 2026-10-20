# One Project, independent public and private repositories

## Runnable recipe

[`recipe.json`](recipe.json) owns the exact host/control-plane plugin selection,
repository paths and executable stages. From the DIM repository root:

```bash
node scripts/examples/run.ts examples/projects/native-multiple-repositories install-host
node scripts/examples/run.ts examples/projects/native-multiple-repositories install-control-plane
node scripts/examples/run.ts examples/projects/native-multiple-repositories verify
```

`verify` is a fast local check using the locked source toolchain; it does not
install plugins or authenticate provider accounts. `dev` runs this directory's
actual setup/service script after the prerequisites below are configured.
For workspace recipes, set `DIM_EXAMPLE_WORK` to a fresh absolute operator
directory; source templates are copied and committed there, never overwritten.

`verify-vm` uses the installed DIM command to create a workspace, run its checked-in
verification script, and discard the workspace on success or failure. It requires
a prepared base image; native recipes also require a live, saved control-plane
connection. It exercises workspace integration, not execution of CI jobs in a
QEMU worker. The separate CI runner gates cover that backend.
See the [recipe runner](../../README.md) for shared options and the heavy VM gate.

Use this layout for a pair such as `mjy9088/codyssey-public` and
`mjy9088/codyssey-private`: one Project, two independent Git histories, separate
proposal grants and reviews, and an explicit integration job. The included
repositories contain disposable sample files so verification needs no GitHub
credentials or access to private product code.

## Required components

On the selected workspace host, `dim installer install core --with-managed`
installs `@slop-lab/dim-host-plugin-native-git`,
`@slop-lab/dim-host-plugin-ci-worker` and `@slop-lab/dim-control-plane-admin`.
Prepare/install/connect the services using
[administration](../../../packages/host/plugins/native-git/docs/cli.md).
The policies in this example select the following control-plane plugins:

```bash
dim installer install control-plane plugin \
  '@slop-lab/dim-control-plane-plugin-git-repositories@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-code-review@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-git-ci@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-merge-policy@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-ci-workflows@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-ci@0.10.0'
```

These install without workspace core on the control-plane machine. Repository
transport, human review, CI integration and protected-ref policy are independent
plugins. `ci-workflows` interprets `.dim/ci/runner.yml`; `git-ci` captures the
selected inputs and connects them to the separate `ci` execution coordinator.
Installing packages alone does not start services. See
[plugin locations](../../../docs/guides/plugin-scopes.md) for standalone runtime
configuration and the separate Docker deployment path.

Running the jobs requires a configured host CI worker and reviewed Sysbox
runner/job images containing Bash and `cmp`. See
[worker setup](../../features/shared-execution/README.md). Worker capacity is
independent of Project import and workspace creation. This example needs no VM
backend or additional guest tool plugin. Development workspaces require a built
Sysbox workspace image and the saved native Git service connection.

## Try the disposable repositories

Run on the selected development host, where the control-plane connection is
saved. Set `example` to this directory in your DIM checkout. The `public/` and
`private/` directories are separate repository templates; the enclosing directory
is documentation and operator input, not a source repository to import.

```bash
example="$PWD/examples/projects/native-multiple-repositories"
work=$(mktemp -d)
for repository in public private; do
  mkdir "$work/$repository"
  cp -R "$example/$repository/." "$work/$repository/"
  git -C "$work/$repository" init --initial-branch=main
  git -C "$work/$repository" add .
  git -C "$work/$repository" -c user.name=Example \
    -c user.email=example@invalid commit -m 'initial example'
done

mkdir -m 0700 "$work/policies"
for repository in public private; do
  install -m 0600 "$example/policies/$repository.json" "$work/policies/$repository.json"
done
dim project create codyssey --project-id codyssey
dim project repository import codyssey public \
  --source "$work/public" --ref refs/heads/main \
  --policy "$work/policies/public.json"
dim project repository import codyssey private \
  --source "$work/private" --ref refs/heads/main \
  --policy "$work/policies/private.json"
dim project configure codyssey \
  --configuration-repository private --default-repository public
dim create dim://codyssey full-dev --repository public --repository private --workdir private
dim exec full-dev -- bash .dim/ci/jobs/integration.bash
dim create dim://codyssey public-dev
dim exec public-dev -- bash .dim/ci/jobs/source.bash
```

`full-dev` has `/workspace/public` and `/workspace/private` and starts in
`/workspace/private`. `public-dev` receives only the default `public` checkout
and its Git grant. The configuration repository is inspected on the host even
when it is not selected; private source is not copied into `public-dev`.

## Apply the pattern to existing repositories

Instead of copying these templates, clone your reviewed sources on that host:

```bash
git clone https://github.com/mjy9088/codyssey-public.git /absolute/sources/codyssey-public
git clone https://github.com/mjy9088/codyssey-private.git /absolute/sources/codyssey-private
```

Authenticate private GitHub access on the operator host. Adapt and commit the
workflow files to the actual project commands before importing those local
paths. Review the policies separately: `policies/*.json` are explicit operator
inputs, not automatically recognized `.dim` files. Replace reviewer `owner` with
an enrolled reviewer and select the actual protected branch.

The public policy permits only `public`, so public candidate YAML cannot read
private source. Private `integration` selects both repositories; `private-check`
selects only itself. Every CI input is pinned to an exact commit/tree. Changing
either input requires fresh review/evidence for the resulting combination.
Promotion updates one repository's protected ref independently. Pushing a
workspace proposal does not update either original GitHub repository.

Discard only these disposable workspaces when finished:

```bash
dim discard full-dev --yes
dim discard public-dev --yes
```

## Linked verification

The source integration tests import these actual repository trees and policy
files into a disposable native Git service, compile their jobs with the actual
workflow plugin, acquire selected snapshots, and execute the sample scripts.
They cover both the successful combination and incompatible public input.
The optional Sysbox journey also uses these files for workspace checkout,
proposal Git, recreation and public-only isolation; see its command in
[verification](../../../docs/development/verification.md).
