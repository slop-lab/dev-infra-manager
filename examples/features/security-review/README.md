# Project-owned security review rules

This recipe requires the control-plane Git repositories, code-review and
merge-policy plugins declared in `recipe.json`. It needs no DIM host plugins.
The reviewed operator adapter in `project-matcher.ts` additionally requires a
local Docker daemon and this exact pre-pulled Node evaluator image:

```bash
docker pull docker.io/library/node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
```

Compose both `await projectReviewMatcherExtension()` from `project-matcher.ts`
and `await retainFilesRefPolicyExtension()` from `ref-policy.ts` into the
control-plane extensions before importing `repository-policy.json`. A different reviewed executor can be
supplied to `createProjectReviewMatcher({execute, revision})`; its explicit SHA256
revision must cover its implementation and every setting that affects matching.
The provider combines that revision with the adapter source digest. Configure
a human reviewer named `security` through code-review's operator
configuration. Ordinary changes need no extra human approval. It requires security
review for changes under `.dim/review/`, changes to `/runtime/isolation` inside
`app/config.json`, and matches returned by the project's own evaluator. Policy
changes remain an operator action; candidate repositories cannot replace that
policy or install adapters.

The `.dim/review/` directory is owned by this example, not an automatic DIM hook.
Only the explicitly composed adapter reads or executes its matcher.

The candidate's `.dim/review/matcher.mjs` decides which application-specific
changes need security review. Appearance changes need no additional approval;
`allowHostAccess`, `allowedCommands` and `credentialScope` changes also need
security review. This adapter sends one self-contained module and changed-file
contents to the container. Bundle any dependencies and configuration into that
module; relative imports or repository filesystem access are unavailable. Keep
any source inputs for that bundle under `.dim/review/` too, so their changes
always require security review.

The evaluator is allowed to change. Changing, deleting or renaming anything in
its guarded directory requires security review **before the candidate evaluator
is run**, regardless of whether its new implementation returns false. Ordinary
changes run the evaluator from the candidate tree. The adapter does not freeze
an evaluator from an earlier protected commit.

Candidate code runs in a disposable container, never in the control-plane
process: no network, mounts, injected service credentials, host control socket,
or writeable root filesystem; unprivileged UID, dropped capabilities, no new
privileges, bounded CPU/memory/PIDs, input, output and execution time. Container
creation and deletion use exact Docker identities. Docker remains a trusted
operator dependency; this is practical isolation, not a hostile tenant guarantee.
Missing code, invalid JSON, nonboolean output, timeout or evaluator failure aborts
review creation. Such failures never become a negative match that skips review.
The adapter bounds source/content sizes intentionally; adapt those reviewed
limits for projects with larger changes.

Run the lightweight behavior checks without Docker:

```bash
node scripts/examples/run.ts examples/features/security-review verify
```

After pulling the pinned image, run actual container acceptance (including error,
invalid return and timeout cleanup):

```bash
cd examples/features/security-review
bash scripts/verify-runtime.bash
# The recipe's explicit dev stage runs the same isolated acceptance.
```

`repository/` is the project template; `repository-policy.json` and
`project-matcher.ts` are reviewed operator assets kept outside that template.
This service recipe does not claim a workspace VM journey. The ordinary source
gate tests the provider interface, mandatory guards and real Git/HTTP approval and
promotion, using a deterministic evaluator substitute without provisioning Docker.
The explicit runtime stage repeats that same end-to-end scenario with the actual
isolated Docker evaluator, including rejection of a self-disabling matcher and
file deletion after human approval.

The separate `retain-files` ref-update policy demonstrates an unconditional
constraint. Its operator options select `.dim/review/matcher.mjs`, which must
remain a regular file in the exact candidate Git tree. Deleting it, turning it
into a directory or a symlink is rejected even after human approval. Updating
the evaluator content remains allowed after the required review. The provider
uses the pinned Git executable with literal paths and sanitized configuration;
it never runs candidate code. It participates in the common protected-ref
compare-and-swap boundary rather than a code-review-specific endpoint.
