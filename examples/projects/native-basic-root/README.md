# Native basic repository

## Required components

Install the native Git host integration and operator tools on the selected
workspace host with `dim installer install core --with-managed`. This profile
installs `@slop-lab/dim-host-plugin-native-git`,
`@slop-lab/dim-host-plugin-ci-worker` and `@slop-lab/dim-control-plane-admin`;
it does not deploy control-plane services. Prepare/install/connect those services
as described in [administration](../../../packages/host/plugins/native-git/docs/cli.md).

The reviewed policy selects these control-plane plugins:

```bash
dim installer install control-plane plugin \
  '@slop-lab/dim-control-plane-plugin-git-repositories@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-code-review@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-git-ci@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-merge-policy@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-ci-workflows@0.10.0' \
  '@slop-lab/dim-control-plane-plugin-ci@0.10.0'
```

`git-repositories` owns Git storage and scoped transport; `code-review` owns human
approval; `git-ci` plans jobs and binds execution evidence; `merge-policy` gates
protected-ref updates. `ci-workflows` only interprets `.dim/ci/runner.yml`; the
separate `ci` coordinator and host `ci-worker` execute its jobs. These services
use the standalone control-plane runtime without workspace core. Installing
packages alone does not configure their private connections or start listeners;
see [plugin locations](../../../docs/guides/plugin-scopes.md).

The example needs no additional guest tool plugin or `.dim/workspace.json`
requirement file. Workspaces require Docker/Sysbox and a built workspace image
(`dim image build`).
To obtain both required CI results, configure a `container` slot with reviewed
Sysbox runner/job images and a `vm` slot with reviewed QEMU runner/job images on
a host with functional KVM. Offline workers do not block Project import or
workspace creation, but leave required job results pending.

## Import and develop

Copy this example into a new Git repository and commit it on `main`. Prepare and
connect an optional control plane on the selected host first. Its private role
files stay outside the repository and workspace; connect saves their selection.
Review `repository-policy.json` as trusted operator input before importing:

```bash
dim project create native-basic --project-id native-basic
dim project repository import native-basic root \
  --source "$PWD" --ref refs/heads/main \
  --policy "$PWD/repository-policy.json" --json
dim project configure native-basic \
  --configuration-repository root --default-repository root --json
dim project repository list native-basic --json
dim create dim://native-basic native-basic-work
dim exec native-basic-work -- git status
```

`root` is an ordinary repository ID chosen for this example. A Project can import
additional independent repositories, such as `public` and `private`, with their
own reviewed policy files. Select them with repeated `--repository` options and
choose the default directory with `--workdir`. Their checkouts live separately at
`/workspace/REPOSITORY`; configuration comes from the Project's independently
selected configuration repository. Unselected repositories receive no guest Git
grant or checkout. Repository names do not change native Git authentication.

The policy permits CI input only from `root`. Extend `extensions["git-ci"].ciRepositoryIds` explicitly
if reviewed jobs should access another repository in this Project. A candidate
workflow cannot widen that operator allowlist itself.

Configure CI worker capacities separately. Project/workspace readiness does not
require workers to be online. A proposal push queues both jobs from `.dim/ci`.
Their evidence is `candidate-controlled`: success means the exact scripts exited
zero under recorded operator images and bounds. It grants neither human approval
nor protected-ref promotion. Each repository is reviewed and promoted independently;
there is no multi-repository atomic promotion.
