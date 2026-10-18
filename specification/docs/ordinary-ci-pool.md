# Ordinary CI execution

Ordinary CI is an optional managed capability. The active deployment combines
native Git authority with a separate ordinary admission/execution service. The
base workspace application does not own CI configuration or require a runner.

Use [managed CI](ci-runners.md) for the active host commands and
[the control-plane installer](../specs/14-installer-facade.md) for deployment.
The unused standalone ordinary authority and worker implementation has been
removed. No manual ordinary-pool or Gitea-backed runner contract remains.

The workflow integration compiles repository configuration to execution inputs.
Git authority binds those inputs to exact candidate objects and review policy.
Workers verify the descriptor and content, execute within their runtime budget,
and report results after cleanup. A successful candidate-controlled self-test
is evidence for review, not promotion authority or independent verification.

Earlier provider-specific operational instructions are available in their
original release history. They must not be used as current setup commands.
