# Scheduled review detectors

`@slop-lab/dim-control-plane-plugin-review-tracing-scheduled` supplies
`node-scheduled` to the review tracing plugin. It submits detector evaluations to
the existing execution scheduler; it does not start Docker, SSH or a second queue
in the repository-owning control plane.

Install the `execution-scheduler` plugin on the scheduler service and configure a task
slot with `taskType: "review-tracing"` and an exact `handlerRevision`. Install
`@slop-lab/dim-host-plugin-execution-worker` and
`@slop-lab/dim-host-plugin-review-tracing-node` on the execution host. The same
worker claim, lease renewal, durable journal, cancellation, cleanup and restart
recovery loop handles CI and detector work. Task-only slots require Docker but
not Sysbox, KVM, Git credentials or a native Git source. Pull the Node runtime's
pinned image on that host before accepting work; see the
[Node runtime](../../../review-tracing-node/README.md).

The scheduler can run in a different process/container/machine from the native
Git services. Its worker needs no connection to the repository service. The
repository owner opens an authenticated task session and answers bounded I/O
requests through the scheduler. Each worker request validates its active
execution lease; the repository owner validates paths, reads exact Git snapshots
and records dependencies itself. A worker-produced manifest cannot erase reads.
The worker receives no repository mount, source credential, review credential or
protected-ref authority.

The host handler's revision binds both its adapter and Node runtime. Print it
from the installed host runtime (use its directory as the working directory):

```sh
node --input-type=module -e "import {reviewTracingTaskHandler as h} from '@slop-lab/dim-host-plugin-review-tracing-node'; console.log(h.revision)"
```

Configure the scheduler worker slot:

```json
{"id":"detectors","taskType":"review-tracing","handlerRevision":"<64 hex characters>"}
```

Use the same slot identity, type and revision in the host worker config. Start it
through the installed worker command, `dim execution worker /absolute/worker.json`.
Configure a separate `credentials.tasks` credential on the scheduler, distinct
from worker/query/operator/webhook and native Git credentials. Configure this
control-plane plugin with:

```json
{
  "endpoint":"https://scheduler.example.test",
  "generationId":"<64 hex characters>",
  "handlerRevision":"<64 hex characters>",
  "credential":{"username":"review-detectors","password":"<task issuer password>"}
}
```

Then select `runtime: "node-scheduled"` in the imported `tracked-project` matcher
options. The credential belongs in private operator configuration, outside the
candidate repository. Endpoint, generation and implementation revisions bind the
review identity. Handler upgrades require updating the scheduler/host pins and
this plugin's pin before new evaluations can succeed.

Cancellation stops the leased evaluation and requires owned resource cleanup
before slot reuse. Lost leases, unavailable capacity, invalid exchange data,
worker errors or implementation mismatch cannot produce an accepted decision.
The repository-side client has a 30-second ceiling (the review orchestrator's
10-second evaluation deadline may be tighter). Scheduler I/O sessions expire
within 60 seconds and are bounded to 32 concurrent sessions and 64 MiB retained
reply data. A scheduler restart loses those transient sessions; evaluations must
restart instead of silently resuming reads against another snapshot. Abrupt host
loss leaves a recovering slot fenced until its exact owned resources are cleaned.

The exchange protocol is general: tasks name an operation and send bounded JSON;
trusted handlers interpret it. The scheduler does not interpret Git paths,
TypeScript, repository workflows or review decisions. The current Node handler
uses a `read` operation; other task plugins can define their own operations.
