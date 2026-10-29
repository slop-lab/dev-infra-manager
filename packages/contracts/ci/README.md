# DIM CI contracts

`@slop-lab/dim-contracts-ci` composes DIM execution grants, results,
credentials, worker placement and scheduler-facing aggregates. Portable CI
workflow, repository input, descriptor, event and review-status schemas live in
`@slop-lab/gs-ci-contracts`.

`/config` and `/worker` expose CI configuration fragments: repository source
credentials and container/VM CI slots. Execution scheduler and worker plugins
compose these with generic execution contracts and validate the complete
configuration. Generic task slots, leases and worker handler extension APIs live
in `@slop-lab/dim-contracts-execution`.

`/worker` also exports `executionWorkerConfigSchema`, the complete deployed
worker document combining CI slots with generic plugin-task slots. Host worker
startup and control-plane operator setup validate the same contract without
loading each other's implementation. `/query` exports the composed
`scheduledSummarySchema` and `executionWorkersSchema` used by service consumers.
