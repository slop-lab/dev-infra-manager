# DIM CI workflows

The optional DIM workflow compiler reads candidate `.dim/ci/runner.yml`:

```yaml
jobs:
  source:
    script: scripts/check.sh
  integration:
    script: scripts/integration.sh
    runtime: vm
    repositories: [public, private]
```

A job needs a script from the candidate repository. Jobs use Sysbox by default;
`runtime: vm` selects a QEMU worker. The compiler supplies the Bash execution
command. Projects install their own tools inside the disposable job. Images,
resource limits, mounts and credentials belong to trusted host policy.

Managed workspace agents can edit this file and its scripts, push an ordinary
candidate branch, and request that candidate with the delivered `dim-ci` helper.
See the [workspace request and evidence commands](../../../host/plugins/native-git/README.md#native-git-host-integration).
The operator must first enable the repository's CI policy and provide matching
capacity; a candidate workflow cannot perform either setup step. This path is
shared by Projects and does not require a DIM source checkout.

The submitting workspace does not need KVM access or the separate `dim-vm`
helper. QEMU execution happens on the configured worker host. A project test
that starts nested VMs additionally needs an operator-selected hardware runner
with usable nested KVM. The YAML selects VM execution, not that trusted profile;
it does not automatically run DIM's own practical scenarios.

The optional Git CI integration selects the installed compiler extension named `dim`
(the exported implementation is `dimWorkflowCompiler`). Repository storage and human reviews do not load a compiler by
themselves. Another `WorkflowCompiler` may use a different configuration path
or language. The compiler exports a stable revision that the GS review
preparation provider validates and binds into its selected provider revision.
Git CI validates immutable candidate objects and job inputs; workers
verify the resulting blob identities without interpreting workflow syntax.

`repositories` optionally requests a finite subset of the Project's repositories.
The job's own repository is always included. The imported repository policy's
`extensions["git-ci"].ciRepositoryIds` allowlist authorizes access; candidate YAML cannot widen it.
An unknown or unauthorized repository makes the candidate plan invalid.

Review creation freezes each selected repository's exact commit and tree. The
primary repository uses the proposal commit; dependencies use their protected
heads. These inputs bind the review, job event and execution descriptor. A
changed dependency produces a new review identity and invalidates old integration
evidence; retries never silently choose newer dependency commits.

Every checkout, including a single-repository job, lives at
`/workspace/<repositoryId>`. The job starts in its own repository directory.
Workers materialize only selected trees, without `.git` or Git credentials.
Joint-job logs and results remain private to the Project; selecting a public
repository does not publish execution artifacts.

## Control-plane plugin

Install `@slop-lab/dim-control-plane-plugin-ci-workflows` with
`dim installer install control-plane plugin PACKAGE...` and select it with
`config: {}` in the standalone runtime configuration. Its `controlPlanePlugin`
exports the workflow compiler capability only. It does not start a CI coordinator
or worker and does not depend on host core or workspace storage. Git CI selects
the compiler extension by name (`dim` by default); the generic control-plane
runtime only checks declared extension identities.
