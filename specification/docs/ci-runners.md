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

## Repository inputs

A workflow job may request `repositories: [public, private]`. Its own repository
is always selected, even when the field is omitted. The source repository's
trusted imported `ciRepositoryIds` allowlist bounds these requests. A candidate
cannot grant itself another repository by changing workflow YAML.

Review creation freezes a canonical map of repository IDs to exact commit/tree
pairs. The primary repository contributes its proposal candidate; dependencies
contribute their protected heads. Each job binds its selected subset into its
event and descriptor. The review identity binds the complete input combination,
so reconciliation with unchanged inputs returns the same immutable review.
A dependency advancing creates a new review identity; old integration evidence
and approvals cannot silently apply to the new combination. Promotion still
performs a compare-and-swap on only the reviewed repository's protected ref.
There is no atomic cross-repository promotion transaction.

Trusted workers acquire short-lived read capabilities for selected repositories,
refreshing expiring capabilities against the same immutable execution grant.
Changed dependencies deny refresh. Jobs receive only materialized trees under
`/workspace/<repositoryId>`, and their current directory is the primary
repository's directory. Git credentials, refs and `.git` remain outside runtime
mounts. Single-repository jobs use the same layout. Execution diagnostics and
joint-job results remain Project-private through existing operator/query roles;
there is no automatic public artifact export.

## Configure capacity

The control-plane facade retains its `nativeGit` and `ordinaryCi` deployment
slots. The second slot hosts the shared execution service for both Sysbox and
QEMU. Configure private service workers/slots with trusted images and bounds;
an empty worker list is a valid idle deployment.

For fresh setup, `dim managed control-plane prepare` accepts `--ci-worker ID`,
`--ci-container-slots COUNT` and digest-pinned `--ci-runner-image`/`--ci-job-image`.
It generates matching service credentials and stable slot IDs. The common
Sysbox profile uses 1 CPU, 2 GiB memory, 512 PIDs, 900 seconds and 1 MiB output;
`--ci-container-profile FILE` supplies an explicit reviewed profile instead.
`--ci-vm-slots COUNT --ci-vm-profile FILE` configures the QEMU backend.
The profile schema below is shared with the service; setup adds no relaxed form.

After installation, `control-plane connect` writes a mode-0600 `worker.json`
for a single configured initial worker using the attested generation, token,
slot IDs and endpoints. `--ci-worker-state-directory` selects an absolute path
on the worker host. Starting capacity remains explicit with
`dim managed ci worker FILE`. A copied worker file needs authenticated SSH
forwards for its loopback endpoints; deployment master role files stay on the
control-plane host. Setup does not mutate an existing deployment, enroll a
remote worker or automatically start capacity.

Each slot selects `runtime: "container"` or `"vm"` and a profile containing
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
reviewed mirror provider supplies owned cache/network routing and read-only job
configuration to the selected backend;
explicit provider failure is reported rather than silently changing routing.
Workers retain their own capacity journal independently of mirror resources.

Ordinary jobs have outbound access through a private container bridge or QEMU
user networking, so job scripts can install their own dependencies. The mirror
plugin owns APT configuration; the execution backend only delivers bounded
read-only configuration files. It does not set a global HTTP proxy.

QEMU uses an exported, reviewed job image, extracted only inside the guest into
a writable temporary root filesystem. It does not extract image archives on
the host or require Docker image-mount support. The root filesystem consumes
guest memory and must fit the configured guest budget along with the job.
Job root can install packages but runs in its own PID/mount namespace without
kernel-admin, resource-admin, ptrace or chroot capabilities. Its inherited PID
limit and system mounts remain protected. The host supervisor stays unprivileged,
with a read-only root, dropped capabilities and only KVM plus explicit candidate
and workspace data. Owned stopped image-export containers and anonymous volumes
are removed before capacity is returned.

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
