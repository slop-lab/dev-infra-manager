# Execution Web plugin

`@slop-lab/dim-web-plugin-execution` provides recent CI jobs, result details,
bounded stdout/stderr, worker capacity and cancel/retry operations. The execution
scheduler still owns state transitions and worker authority.

Install alongside the exact matching `@slop-lab/dim-web` version. When selected
without configuration, the plugin discovers execution connections through the
Web server's configured controllers. The controller needs
`@slop-lab/dim-host-plugin-execution-worker` and a selected control plane with
generated query credentials. Its optional operator connection enables capacity,
cancel and retry. Credentials stay on the controller; the browser selects an
explicit controller and every action pins the discovered service generation.
An unavailable controller does not disable other controllers or features.

For a direct server connection, register private server-side configuration:

```json
{"queryConnection":"/absolute/ci-query.json","operatorConnection":"/absolute/execution-operator.json"}
```

The operator connection is optional. Connection files must be caller-owned,
mode-0600 regular files. Paths and credentials are never delivered to the
browser. Reading jobs requires `read`; capacity, cancel and retry require
`operator`. Retries include an explicit request UUID to avoid duplicate jobs.

The browser loads recent jobs and worker capacity independently. A capacity
failure leaves the job list, filters and details usable and offers its own retry.
Search matches job names, IDs, projects and repositories; the state filter keeps
open job details in place. Detail views show only public result metadata and the
bounded stdout/stderr returned by the execution query contract. An accepted
cancel or retry remains accepted if a following read fails, and retry reuses its
request UUID after response loss.

Automatically discovered execution controllers retain the configured host ID as
navigation provenance. Git can open an exact repository-scoped job filter, and a
CI job can open the matching Native Git repository without inferring another
controller. Job links and repository filters are accepted only while the target
is present in the selected controller's current job catalog. Direct query/operator
connections remain independent and expose no inferred Git identity. Worker
capacity links active CI slots to the existing job detail view; generic task slots
show their task type and execution kind without calling the CI detail operation.
