# Native basic repository

## Required components

Install matching managed administration on the selected host with
`dim installer install core --with-managed`. Prepare/install/connect its native
Git and CI services as described in [managed administration](../../../core/packages/managed/docs/cli.md).
`@slop-lab/dim-plugin-control-plane-native-git` supplies the Git service;
`@slop-lab/dim-plugin-control-plane-ci-workflows` supplies the `.dim/ci/runner.yml`
compiler. Install these on the control-plane machine with
`dim installer install control-plane plugin PACKAGE@EXACT_VERSION`.
They use the standalone control-plane runtime without workspace core. They are
control-plane plugins, separate from `.dim/workspace.json` host requirements;
see [plugin locations](../../../specification/docs/plugin-scopes.md).

This example needs no optional host plugin, so it has no host-plugin requirement
file. It still requires a Docker/Sysbox host and a built workspace image
(`dim image build`) to start a development workspace.
To obtain both required CI results, configure a `container` slot with reviewed
Sysbox runner/job images and a `vm` slot with reviewed QEMU runner/job images on
a host with functional KVM. Offline workers do not block Project import or
workspace creation, but leave required job results pending.

## Import and develop

Copy this example into a new Git repository and commit it on `main`. Prepare and
connect an optional control plane on the selected host first. Its private role
files stay outside the repository and workspace; connect saves their selection.
Review `review-policy.json` as trusted operator input before importing:

```bash
dim managed project create native-basic --project-id native-basic
dim managed project repository import native-basic root \
  --source "$PWD" --ref refs/heads/main \
  --review-policy "$PWD/review-policy.json" --json
dim managed project configure native-basic \
  --configuration-repository root --default-repository root --json
dim managed project repository list native-basic --json
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

The policy permits CI input only from `root`. Extend `ciRepositoryIds` explicitly
if reviewed jobs should access another repository in this Project. A candidate
workflow cannot widen that operator allowlist itself.

Configure CI worker capacities separately. Project/workspace readiness does not
require workers to be online. A proposal push queues both jobs from `.dim/ci`.
Their evidence is `candidate-controlled`: success means the exact scripts exited
zero under recorded operator images and bounds. It grants neither human approval
nor protected-ref promotion. Each repository is reviewed and promoted independently;
there is no multi-repository atomic promotion.
