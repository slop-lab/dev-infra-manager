# DIM CI workflows

The optional DIM workflow compiler reads candidate `.dim/ci/runner.yml`:

```yaml
jobs:
  source:
    script: scripts/check.sh
  integration:
    script: scripts/integration.sh
    runtime: qemu
```

A job needs a script from the candidate repository. Jobs use Sysbox by default;
`runtime: qemu` selects a QEMU worker. The compiler supplies the Bash execution
command. Projects install their own tools inside the disposable job. Images,
resource limits, mounts and credentials belong to trusted host policy.

The managed native Git service supplies `dimWorkflowCompiler`. Library callers
can inject another `WorkflowCompiler`, including a different configuration path
or language. Git validates immutable candidate objects and job inputs; workers
verify the resulting blob identities without interpreting workflow syntax.
