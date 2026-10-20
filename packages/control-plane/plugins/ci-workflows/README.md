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

The optional Git CI integration selects the installed compiler extension named `dim`
(the exported implementation is `dimWorkflowCompiler`). Repository storage and human reviews do not load a compiler by
themselves. Another `WorkflowCompiler` may use a different configuration path
or language. Git CI validates immutable candidate objects and job inputs; workers
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
