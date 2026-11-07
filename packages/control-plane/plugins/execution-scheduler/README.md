# Control-plane execution scheduler

`@slop-lab/dim-control-plane-plugin-execution-scheduler` owns the shared durable task queue, slot ownership, leases and state transitions, along with HTTP coordination and CI-specific authorization/publication. Its internal `TaskStore` validates domain codecs and complete persisted aggregates; it is not a separate service or installable library. It starts no Docker containers or VMs and requires no host core or workspace store.

Install it explicitly for the control plane:

```sh
dim installer install control-plane plugin @slop-lab/dim-control-plane-plugin-execution-scheduler@0.10.0
```

The package exports `controlPlanePlugin` for `dim-control-plane`. Its private plugin configuration contains `service` (the composed execution service configuration), `stateDirectory`, `readinessToken`, `activationToken`, `expectedGenerationId`, and optional `listen: {host,port}`. CI slots require explicit Git authority credentials and registered worker identities/profiles. Task-only configurations omit `nativeGit` and use a separate `credentials.tasks` issuer. No worker or workflow compiler is implicitly installed or started.

The `dim-execution-scheduler` executable is the installed service-image entrypoint. It provides configuration/state checks, generation activation, readiness and serving with the installer's fixed secret/state paths. Deployment remains the installer's atomic service-pair operation; installing this package alone does not deploy it.

Scheduler SQLite state remains format 102 with exactly the `executions` and
`metadata` tables. Execution bodies retain the format-102 aggregate shape.
Generation-bound worker enrollments and bounded admission diagnostics use
validated `execution-scheduler/...` metadata keys, so they survive restart and
rollback without adding fields that strict format-102 execution readers reject.
Rows from previous generations remain available to the matching generation;
unrecognized metadata namespaces are preserved.

Trusted host execution is supplied separately by `@slop-lab/dim-host-plugin-execution-worker`. Generic transport, configuration and task plugin interfaces belong to `@slop-lab/dim-contracts-execution`; CI-specific grants/results belong to `@slop-lab/dim-contracts-ci`; the coordinator does not import a host worker or backend.

General task slots specify `{id, taskType, handlerRevision}` instead of a CI
runtime/profile. Their handlers are trusted host plugins. Both forms share the
same database, occupied-slot index, claim/renew/recover API and host journal loop;
a task kind does not create another scheduler. Handler revisions are pinned at
submission and matched before reservation. The lease-authenticated exchange
endpoint transports bounded opaque operations without interpreting project code.
Restarting the coordinator invalidates transient exchange sessions; affected
tasks must be evaluated again. CI-only query/log operations retain their CI
shape; operator worker status, cancellation and recovery include general tasks.
An interactive task retry requires a fresh issuer session rather than replaying
callbacks from an earlier evaluation.

Task producers use `runScheduledTask` from `@slop-lab/dim-service-client-execution/tasks`.
That entry point handles task submission and bounded exchange without loading
the scheduler, SQLite store or host implementation. Shared task schemas remain
in the execution contracts; composed CI/task status and worker configuration
belong to the CI contracts used by both service and operator adapters.

See [scheduled review detectors](../git-review-tracing-scheduled/README.md) for a
complete non-CI use case, required host/control-plane plugins and setup.

## Artifact storage and query

Execution owns bounded artifact bytes under the private `artifacts/` child of its existing state directory (and therefore its operator-selected state volume). Each execution has an immutable digest-verified manifest and files. Metadata publication uses synced private temporary files and exclusive links; data chunks can be retried or resumed. Storage survives service restart without putting blob bytes in SQLite or Native Git results.

Workers upload through the current worker/slot/lease/generation/descriptor authority. Query credentials can list a job manifest and download its opaque artifact IDs, or look up up to32newest executions for an exact event. Workspace-facing CI adapters must apply their project/repository/review grant scope before using this private query API; service-wide query credentials never enter a workspace. Captured collection availability and job completion are separate. Listed files retain verified availability even if another requested file could not be captured.

Optional `service.capacityProviders` configures demand-managed, fixed pre-enrolled
worker pools. The scheduler owns generation-bound start reservations, idle
hysteresis and atomic claim/drain exclusion; it never starts host processes.
Dedicated provider credentials can use only `POST /v1/capacity/reconcile` and
`POST /v1/capacity/stop`, scoped to their exact pool. They are distinct from
operator, query, task, CI and worker credentials. Pool costs reserve its entire
maximum CPU/memory/pids envelope, including trusted task slots. There is no
capacity-provider enrollment/token rotation or candidate-controlled scaling
policy. See [runner setup](../../../../docs/guides/ci-runners.md#demand-managed-worker-pools)
for complete operator and host configuration and preservation boundaries.
