# Project-owned security review rules

This recipe requires the control-plane Git repositories, code-review and
merge-policy plugins declared in `recipe.json`. It needs no DIM host plugins.
The explicit runtime stage additionally needs a rootful Docker daemon with `sysbox-runc`; it starts two disposable DinD services.
The reviewed operator adapter in `project-matcher.ts` additionally requires a
local Docker daemon and these exact pre-pulled images:

```bash
docker pull docker.io/library/node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
docker pull docker@sha256:173f284a4299164772a90f52b373e73e087583c0963f1334c9995f190ef6f3f5
```

Compose both `await projectReviewMatcherExtension()` from `project-matcher.ts`
and `await retainFilesRefPolicyExtension()` from `ref-policy.ts` into the
control-plane extensions before importing `repository-policy.json`. A different reviewed executor can be
supplied to `createProjectReviewMatcher({execute, revision})`; its explicit SHA256
revision must cover its implementation and every setting that affects matching.
The provider combines that revision with the adapter source digest. Configure
a human reviewer named `security` through code-review's operator
configuration. Ordinary changes need no extra human approval. It requires security
review for every change under `.dim/`, changes to `/runtime/isolation` inside
`app/config.json`, and matches returned by the project's own evaluator. Policy
changes remain an operator action; candidate repositories cannot replace that
policy or install adapters.

The `.dim/review/` directory and `.dim/security-boundary.json` are owned by this
example, not automatic DIM hooks.
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
`.dim/` requires security review **before the candidate evaluator
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

## Separate untrusted and secret-bearing services

`repository/.dim/security-boundary.json` declares two separate Sysbox containers,
`agent-dind` and `secure-dind`, each with its own Docker daemon. Only `secure-dind`
receives a read-only `/run/secrets/service-token` mount. Neither role receives the
host Docker socket; the agent cannot select the secure daemon. Both have no
service network, so the agent cannot contact a privileged API by service name.
A project that needs a shared service must add an explicitly reviewed narrow
interface rather than sharing the secure Docker socket or raw token.

The reviewed operator module `boundary.ts` reads that configuration through
`parseBoundaryConfiguration` and `startBoundary`. Supply a private regular
secret file owned by the operator, outside the repository. Invoke it using the
configuration from the exact promoted protected commit; never execute a mutable
agent checkout as an operator. The launcher deliberately supports one pinned
image/runtime and isolated networks. Changing supported isolation mechanisms
also requires reviewing the operator module. Call the returned `close()` when
the service session ends.

The explicit runtime acceptance generates a random dummy token in a private
temporary directory and launches those two actual daemons. It verifies the
secure role can read it, the mount rejects writes, the agent has no token mount
or environment entry, the daemon identities differ, agent Docker cannot inspect
secure containers, and the secure daemon is unreachable over the network. It
then deletes exact fixture containers and volumes. It never reads real operator
credentials or reconfigures the host daemon.

The ordinary Git/HTTP integration also proposes changes to service secret
mounts, service networking and runtime selection under `.dim/`. Each promotion
fails before human security approval and succeeds afterward. Application or
documentation changes outside `.dim/` require no human review unless they match
the example's explicit JSON/custom rules. The path rule applies to additions,
deletions and renames as well as edits. Repository code cannot disable it by
rewriting its own matcher.
