# DIM CI contracts

`@slop-lab/dim-contracts-ci` defines repository CI events, reviewed execution
inputs, execution grants, results and CI status projections. It does not provide
an execution scheduler or a worker implementation.

`/config` and `/worker` expose CI configuration fragments: repository source
credentials and container/VM CI slots. Execution scheduler and worker plugins
compose these with generic execution contracts and validate the complete
configuration. Generic task slots, leases and worker handler extension APIs live
in `@slop-lab/dim-contracts-execution`.
