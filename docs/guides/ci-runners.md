# Shared candidate execution

CI is optional. A Git repository can be developed without any queue or worker.
For managed proposals, the optional Git-CI plugin compiles the exact candidate
configuration through its selected workflow plugin and durably sends normalized
jobs to one execution service. Git-repositories and code-review can operate
without Git-CI or a compiler. Registration makes Projects eligible; protected policy
selects which successful results promotion requires, not which valid jobs run.

The execution service owns one durable aggregate per job/attempt. Its phases
are queued, assigned, running, recovering and finished. Worker/slot identity,
profile, lease, grant and terminal result are fields of that aggregate. Expired
or interrupted work holds capacity until owned cleanup is confirmed. The worker
journals requests and cleaned results so transport retries preserve identity.

Result acceptance and Git publication are separate: cleaned capacity can be
returned after durable result acceptance while a Git outage is retried. Git-CI
accepts only exact candidate evidence for the current execution attempt. Results
remain candidate-controlled and do not approve or promote their own source.

## Repository inputs

CI is enabled only by trusted repository policy. A checked-in
`.dim/ci/runner.yml` does not enable planning or a merge gate by itself:

```yaml
policy:
  git-ci:
    ciRepositoryIds: [main]
    requiredJobs:
      - name: source
        kind: ordinary-sysbox
        evidenceClass: candidate-controlled
```

Use the actual repository ID, workflow job name and execution kind. Apply the
reviewed policy explicitly with `dim project repository policy update PROJECT
REPOSITORY --file /absolute/reviewed/repos.yml`; changing a source file alone
does not change running authority. Resolve a fresh exact review afterward.
Human approval, healthy workers and external GitHub checks are not successful
DIM execution evidence. Review inspection exposes policy absence, no required
jobs, pending, failed, stale/unavailable and successful required evidence.

A workflow job may request `repositories: [public, private]`. Its own repository
is always selected, even when the field is omitted. The source repository's
trusted imported `extensions["git-ci"].ciRepositoryIds` allowlist bounds these requests. A candidate
cannot grant itself another repository by changing workflow YAML.

Review creation freezes a canonical map of repository IDs to exact commit/tree
pairs. The primary repository contributes its proposal candidate; dependencies
contribute their protected heads. Each job binds its selected subset into its
event and descriptor. The review identity binds the complete input combination,
so reconciliation with unchanged inputs returns the same immutable review.
The complete trusted policy digest also binds review, so changing quality policy
requires a fresh approval. A dependency advancing creates a new review identity;
old integration evidence
and approvals cannot silently apply to the new combination. Promotion still
performs a compare-and-swap on only the reviewed repository's protected ref.
There is no atomic cross-repository promotion transaction.

Trusted workers acquire short-lived read capabilities for selected repositories,
refreshing expiring capabilities against the same immutable execution grant.
Changed dependencies deny refresh. Jobs receive only materialized trees under
`/workspace/<repositoryId>`, and their current directory is the primary
repository's directory. Git credentials, refs and `.git` remain outside runtime
mounts. During trusted acquisition, each selected repository is fetched and
verified once; configuration, scripts and checkout trees reuse those immutable
objects. Extraction byte and entry limits apply across the job's repositories.
Before handoff, a remote probe revalidates the live execution lease and protected
head, then the worker removes its temporary Git sessions before starting code.
Single-repository jobs use the same layout. Execution diagnostics and
joint-job results remain Project-private through existing operator/query roles;
there is no automatic public artifact export.

## Configure capacity

The control-plane facade retains its `nativeGit` and `execution` deployment
slots. The second slot hosts the shared execution service for both Sysbox and
QEMU. Configure private service workers/slots with trusted images and bounds;
an empty worker list is a valid idle deployment.

For fresh setup, `dim control-plane prepare` accepts `--execution-worker ID`,
`--ci-container-slots COUNT` and digest-pinned `--ci-runner-image`/`--ci-job-image`.
It generates matching service credentials and stable slot IDs. The common
Sysbox profile uses 1 CPU, 2 GiB memory, 512 PIDs, 900 seconds and 1 MiB output;
`--ci-container-profile FILE` supplies an explicit reviewed profile instead.
`--ci-vm-slots COUNT --ci-vm-profile FILE` configures the QEMU backend.
The profile schema below is shared with the service; setup adds no relaxed form.

After installation, `control-plane connect` writes a mode-0600 `worker.json`
for a single configured initial worker using the attested generation, token,
slot IDs and endpoints. `--execution-worker-state-directory` selects an absolute path
on the worker host. Starting capacity remains explicit with
`dim execution worker FILE`. A copied worker file needs authenticated SSH
forwards for its loopback endpoints; deployment master role files stay on the
control-plane host. These prepare/connect operations do not mutate an existing
deployment or automatically enroll/start remote capacity; use the explicit
existing-plane enrollment below.

Each slot selects `runtime: "container"` or `"vm"` and a profile containing
`runnerBaseImage`, `jobBaseImage` and positive string bounds `cpu`,
`memoryBytes`, `pids`, `wallClockSeconds`, `outputBytes`. Both images are reviewed
digest references. Candidate content supplies job names, script blobs and
compiled argv; it does not choose these profiles, devices, mounts or credentials.

The private host file identifies one configured worker, matching slots, the
installed generation, CI/Git endpoints, an owned state directory, Git executable
and that worker's token. See the [complete example](../../examples/features/shared-execution/README.md).

```bash
dim --host devbox execution worker /srv/dim/worker.json
# Build the reviewed QEMU supervisor before choosing its deployed digest:
dim --host devbox execution qemu-image registry.example/qemu-supervisor:reviewed
```

The Web Execution page lists configured worker slots and shows setup guidance.
An idle slot is a scheduler reservation state, not proof that its worker process
is running. When a job remains queued with an idle matching slot, check the
worker process and its service connection on the selected host. Generic plugin
tasks share worker capacity; their task-specific controls belong to the owning
plugin.

### Add capacity to an existing control plane

Use the existing generation-bound private execution-operator connection on the
selected host. Enrollment is an explicit operator API, not a candidate workflow,
an installer deployment, a repository policy edit or a guest capability. It
adds a new identity/profile without replacing existing workers, leases, tokens,
workspaces or sessions. Slot IDs are local to each worker: several hosts may
each have `build-1` and `build-2`.

Prepare an absolute operator-owned mode-0600 capacity specification. For example,
replace both image placeholders with actual reviewed digest references:

```json
{
  "schemaVersion": 1,
  "workerId": "ci-build-host",
  "stateDirectory": "/srv/dim/ci-build-host",
  "gitExecutable": "/usr/bin/git",
  "nativeGitEndpoint": "http://127.0.0.1:18080",
  "slots": [{
    "id": "build-1",
    "runtime": "container",
    "profile": {
      "runnerBaseImage": "REVIEWED_RUNNER@sha256:REVIEWED_DIGEST",
      "jobBaseImage": "REVIEWED_JOB@sha256:REVIEWED_DIGEST",
      "bounds": {
        "cpu": "4", "memoryBytes": "8589934592", "pids": "2048",
        "wallClockSeconds": "900", "outputBytes": "1048576"
      }
    }
  }]
}
```

For two slots, add a second independently named slot with the same reviewed
profile. Use the actual accessible private endpoint/SSH forward on the worker
host, not an arbitrary candidate-supplied URL. Candidate YAML still selects only
scripts/arguments and trusted repository inputs, never images, bounds, mounts or
operator credentials.

```bash
chmod 0600 /absolute/operator/capacity.json
dim --host build-host execution worker enroll \
  --connection /absolute/private/execution-operator.json \
  --spec /absolute/operator/capacity.json \
  --output /absolute/private/worker.json
dim --host build-host execution worker discover \
  --connection /absolute/private/execution-operator.json --json
dim --host build-host execution worker /absolute/private/worker.json
```

The last command runs the worker in the foreground; operator-selected
supervision is explicit. Installing the plugin or enrollment alone starts no
worker and enables no system service. Runtime prerequisite validation occurs
before claims. Enrollment persists across scheduler restart. Wrong roles/stale
generations, conflicting worker IDs and duplicate slots within a worker fail
before replacing existing authority. Discovery returns configured capacity and
bounded recent authenticated contact (`observedConnected`, `lastSeenAt`), not
tokens or a permanent claim that a process is healthy. Availability expires
without contact; an idle slot alone is not running capacity.

If enrollment was accepted but the private output could not be published or its
response was lost, inspect current worker state and export the enrolled identity
to a fresh path using the same exact trusted capacity spec:

```bash
dim --host build-host execution worker export \
  --connection /absolute/private/execution-operator.json \
  --spec /absolute/operator/capacity.json \
  --output /absolute/private/recovered-worker.json
```

Export does not rotate credentials or widen slots. Existing output files are
never overwritten; no worker token is printed to stdout. Bootstrap workers from
the original deployment retain their existing `control-plane connect` path.

### Enable and verify a DIM merge gate

1. Deploy matching reviewed service/host artifacts through the separate operator
   deployment process. Source development and disposable tests do not do this.
2. Enroll/start trusted capacity, inspect recent contact, and run a tiny
   disposable capacity job before enabling a large repository's CI policy.
3. Apply explicit reviewed `git-ci` policy naming every required job. Do not
   infer enablement from a workflow file or from a previous experiment.
4. Resolve/prepare a fresh review and inspect its DIM CI state. Follow the
   repository's execution jobs until each required current attempt succeeds and
   its result is published/accepted by Git authority.
5. Approve when human policy requires it, then merge/promote using the separate
   promoter role. Failed historical jobs remain history, not green evidence.

The DIM merge-quality guard, not GitHub CI, decides whether required current
execution evidence is acceptable. A Git outage after result acceptance leaves
publication pending and still blocks the DIM gate until authority accepts it.

### Admission and proof latency diagnostics

Capacity, admission, guest execution and evidence publication are different
phases. If tiny capacity jobs pass but a large repository fails before scripts
start, inspect admission/source-proof diagnostics rather than increasing guest
CPU/memory blindly. Check current generation/policy, protected/source refs,
review inputs and Git proof/reconciliation load. A stale source needs a fresh
review; repeated retries of old immutable input do not refresh it.

Large repositories still receive strict full Git integrity verification. Proofs
are reused only within one request and followed by current authority/ref/input
checks, never a cross-request stale authorization cache. Policy reconciliation
uses its bounded retry mechanism rather than delaying the committed policy
response on historical proposals. Git admission deadlines are nested beneath
the scheduler/worker deadlines; reservation ownership and cancellation are
rechecked while admission is pending. Short-lived credentials are issued after
proof, not lengthened to hide slow verification. Lease responses separate
pre-issuance processing from transit while retaining conservative expiry.

Public diagnostics use fixed phase/code metadata, not raw host exceptions,
private paths, credentials or authorization headers. Keep guest stdout/stderr in
the explicit private log view; it is not the primary admission diagnosis. A
timeout, stale acquisition or executor failure is never a successful CI check.

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
`packages/host/plugins/execution-worker/src/`; Git owns only its job/grant/evidence wire contract.
Installation, image/state checks and activation remain installer responsibilities.

## Inspect executions

```bash
dim --host devbox control-plane ci jobs --json
dim --host devbox control-plane ci logs EXECUTION_ID
dim --host devbox control-plane ci logs EXECUTION_ID --json
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
