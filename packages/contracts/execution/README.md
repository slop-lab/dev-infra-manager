# DIM execution contracts

`@slop-lab/dim-contracts-execution` defines generic scheduled work independently
of the scheduler implementation and CI repository jobs.

- The package root exports assignments, leases, task inputs, results, schemas and
  the shared `ExecutionConflictError`.
- `/plugin-api` defines `ExecutionTaskHandler` and discovers worker handlers from
  extensions. A handler owns task execution and exact owned-resource cleanup.
- `/config` defines generic credentials, endpoints, worker registration and task
  slots. Scheduler and worker plugins compose these with integration-specific
  configuration; the contracts do not depend on those implementations.
- `/connections` defines operator connection data; `/query` defines task status.

The durable queue and HTTP service belong to
`@slop-lab/dim-control-plane-plugin-execution-scheduler`. Producers submit tasks
through `@slop-lab/dim-execution-client/tasks`, without importing the SQLite-backed
store. Composed CI/task worker configuration and query projections live in
`@slop-lab/dim-contracts-ci/worker` and `/query`.
