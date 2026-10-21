# Automatically protected review dependencies

This recipe declares the Git repositories, code-review, merge-policy,
review-tracing and review-tracing-node control-plane plugins. It needs no host
plugins. Configure a human reviewer named `security`. The operator policy names
only the matcher entrypoint and runtime; it contains no manually maintained
path protection list.

`repository/` is the candidate project template. Its matcher imports a helper,
which reads `settings.json` as an ordinary dependency. The matcher reads
`app/config.json` explicitly as target data and compares only
`runtime.isolation`. Theme changes need no security approval. Changing the
entrypoint, imported helper or settings requires approval even when the matcher
returns false. Adding a dependency or deleting an established dependency also
requires approval. A candidate cannot downgrade an established dependency by
calling it target data.

The entrypoint `.dim/review/matcher.ts` and its helper use erasable TypeScript.
The Node adapter strips types during execution and tracks the original `.ts`
source. Run strict static type checking separately in the project:

```bash
cd repository
npm install
npm run check
```

The template pins TypeScript and the neutral Node runtime's virtual API types as
development dependencies. The runtime does not install these dependencies or
read `tsconfig.json`; relative imports keep explicit `.ts` extensions. Use
`import type` for declarations and avoid syntax requiring code generation,
including enums and parameter properties.

The Node adapter runs candidate code in a disposable Docker container. Its
broker serves bounded files from the exact Git trees; candidate code cannot
open the repository directly. Relative imports and `readText(path)` record
ordinary dependencies. `readTarget(path, 'before' | 'after')` identifies data
whose meaning the matcher interprets. Dependency classification wins when a
path is used for both. Missing code, unsupported imports, invalid results and
runtime errors fail closed; they never silently skip review.

Dependency discovery is dynamic, so both the current protected matcher and the
candidate matcher execute when their dependency sets are compared. The
candidate matcher decides the application-specific result; the protected
execution establishes the existing dependency protection. This does not pin
application matching to old code. A newly activated conditional dependency
requires approval before it can influence promotion without review.

Install/configure all declared control-plane plugins before importing
`repository-policy.json`. The tracing plugin discovers runtime extensions from
the Node plugin. Other language adapters can provide the same runtime extension
without changing the Git or code-review services.

Run the ordinary Git/HTTP integration without Docker:

```bash
node scripts/examples/run.ts examples/features/review-tracing verify
```

The ordinary check substitutes only candidate execution; it exercises the real
file tracker, protected Git refs, review creation, approval and promotion. For
actual relative imports, broker reads and process isolation, first pull the
reviewed image:

```bash
docker pull docker.io/library/node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
cd examples/features/review-tracing
bash scripts/verify-runtime.bash
```

The explicit `dev` stage runs this same Docker acceptance. It is separate from
the lightweight recipe verification and makes no workspace-VM claim.

To verify the complete approval and promotion flow using a scheduled detector,
run this optional acceptance from the DIM repository root:

```bash
DIM_TEST_REVIEW_TRACE_DOCKER=1 DIM_TEST_REVIEW_TRACE_SCHEDULED=1 \
  pnpm --dir tests exec vitest run scenarios/harness/trackedReviewIntegration.test.ts
```

That deployment additionally needs the scheduler's `execution-scheduler` control-plane plugin,
the repository owner's `review-tracing-scheduled` control-plane plugin, and the
execution host's `execution-worker` and `review-tracing-node` plugins. See the
[scheduled execution recipe](../scheduled-review/README.md) for their roles.
The acceptance starts an actual HTTP scheduler and host worker alongside the
Git/HTTP review services, then executes TypeScript in Docker. These harness
services share one OS process; the test makes no separate-machine claim.

Discovery compares the two executions for the current proposal; it is not a
persisted history of dependencies. If a formerly dormant branch becomes reachable
in both executions, its files are compared between those two snapshots, but
earlier edits are not retroactively reviewed. Keep explicit path rules when every
potential dependency must be protected before any execution reaches it.
