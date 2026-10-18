# Shared candidate execution

CI is optional. A Git repository can be developed without any queue or worker.
For managed proposals, native Git compiles the exact candidate configuration
through the selected workflow plugin and durably sends normalized jobs to one
execution service. Registration makes Projects eligible; protected policy
selects which successful results promotion requires, not which valid jobs run.

The execution service owns one durable aggregate per job/attempt. Its phases
are queued, assigned, running, recovering and finished. Worker/slot identity,
profile, lease, grant and terminal result are fields of that aggregate. Expired
or interrupted work holds capacity until owned cleanup is confirmed. The worker
journals requests and cleaned results so transport retries preserve identity.

Result acceptance and Git publication are separate: cleaned capacity can be
returned after durable result acceptance while a Git outage is retried. Git
accepts only exact candidate evidence for the current execution attempt. Results
remain candidate-controlled and do not approve or promote their own source.

## Configure capacity

The control-plane facade retains its `nativeGit` and `ordinaryCi` deployment
slots. The second slot hosts the shared execution service for both Sysbox and
QEMU. Configure private service workers/slots with trusted images and bounds;
an empty worker list is a valid idle deployment.

Each slot selects `runtime: "sysbox"` or `"qemu"` and a profile containing
`runnerBaseImage`, `jobBaseImage` and positive string bounds `cpu`,
`memoryBytes`, `pids`, `wallClockSeconds`, `outputBytes`. Both images are reviewed
digest references. Candidate content supplies job names, script blobs and
compiled argv; it does not choose these profiles, devices, mounts or credentials.

The private host file identifies one configured worker, matching slots, the
installed generation, CI/Git endpoints, an owned state directory, Git executable
and that worker's token. See the [complete example](../../examples/features/shared-execution/README.md).

```bash
dim --host devbox managed ci worker /srv/dim/worker.json
# Build the reviewed QEMU supervisor before choosing its deployed digest:
dim --host devbox managed ci qemu-image registry.example/qemu-supervisor:reviewed
```

The worker validates Docker and required Sysbox/KVM access before reserving
jobs. Multiple Projects share configured slots; there is no per-Project runner
registration or separate QEMU scheduler. Only select QEMU slots on hosts with
real KVM. Missing hardware is unavailable; another backend is not a substitute.

Mirrors are optional host integration. Direct pulls work by default. An enabled
reviewed mirror provider supplies owned cache/network routing to Sysbox jobs;
explicit provider failure is reported rather than silently changing routing.
Workers retain their own capacity journal independently of mirror resources.

Service grammar and worker grammar belong to the execution implementation in
`core/packages/managed/src/ci/`; Git owns only its job/grant/evidence wire contract.
Installation, image/state checks and activation remain installer responsibilities.

## Inspect executions

```bash
dim --host devbox managed ci jobs --json
dim --host devbox managed ci logs EXECUTION_ID
dim --host devbox managed ci logs EXECUTION_ID --json
```

Control-plane connect generates private `ci-query.json` from the prepared CI
query role, bound to the installed generation. It saves the connection beside
the selected host connection even when CI is offline. Queries check that
service generation when used; worker and webhook credentials cannot read jobs.
An explicit `--connection FILE` overrides the selected host's query file.

Recent history returns at most 100 summaries, without execution grants, lease
tokens or raw diagnostics. Individual execution detail retains at most 64 KiB
per output stream. Text logs preserve stdout/stderr bytes and report retained
prefix lengths when truncated; JSON carries base64 diagnostics and result
metadata. Result acceptance, Git publication and human approval are distinct
states: a successful execution can still await publication and review.
