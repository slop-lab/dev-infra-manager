# Execution Web plugin

`@slop-lab/dim-web-plugin-execution` provides a task-centered execution
workbench for recent CI jobs, result details, bounded stdout/stderr, shared worker
capacity and cancel/retry operations. The execution scheduler still owns state
transitions and worker authority.

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
Cancellation receipts are scoped to the exact job and service. Accepted and
unknown cancellations remain locked through stale or failed reads; only an
authoritative read begun after the cancellation can reconcile its state. Refresh
also updates the selected job detail without submitting cancellation again.

The workbench uses native task and object URLs below `#/features/execution`.
Automatically discovered connections use `controllers/CONTROLLER/jobs`,
`controllers/CONTROLLER/jobs/JOB_UUID`, `controllers/CONTROLLER/workers`, and
`controllers/CONTROLLER/launch`; a direct private service uses the same tails
without the controller prefix. Reload, Back/Forward and a new tab therefore
retain both the selected service authority and the selected section or exact job
when it remains in that controller's current catalog. Controller provenance stays
visible because automatically discovered services are separate scheduler
authorities even when their job names match.

The **Launch & ownership** section intentionally has no submission form. The
public Web owner contract has no arbitrary-command or generic task-launch
operation. Installed task producers submit typed tasks through
`@slop-lab/dim-service-client-execution/tasks` and own their input,
authorization, results and recovery. Generic task slots remain visible in worker
capacity, including their task type and execution kind, but the CI query contract
does not provide their detail, logs or artifacts. CI job logs are the bounded
stdout/stderr embedded in `jobs.detail`; no streaming log endpoint or downloadable
artifact endpoint is advertised. The UI states these limits instead of implying
that absent controls can be enabled by selecting a different host.

Automatically discovered execution controllers retain the configured host ID as
navigation provenance. Git can open an exact repository-scoped job filter, and a
CI job can open the matching Native Git repository without inferring another
controller. Job links and repository filters are accepted only while the target
is present in the selected controller's current job catalog. Direct query/operator
connections remain independent and expose no inferred Git identity. Worker
capacity links active CI slots to the existing job detail view; generic task slots
show their task type and execution kind without calling the CI detail operation.
