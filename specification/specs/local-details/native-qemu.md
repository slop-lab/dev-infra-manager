# Native QEMU Scheduler and Evidence

**Kind: Implementation profile**

**Status: Host-file preflight, schema-4 candidate parsing, authoritative native-Git descriptor derivation, automatic scheduler eligibility, durable result reporting, and dedicated scheduler/host package surfaces are implemented. Clean-host KVM acceptance remains environment-gated and is not implied by unit or simulated scheduler tests.**

## Operator deployment contract

**NATIVE-QEMU-OPERATOR-001:** `dim ci native-qemu scheduler run CONFIG`
starts only the independently deployed scheduler from an absolute, owner-only
mode-`0600` JSON file. `dim ci native-qemu host run HOST_ID CONNECTION` starts
only the trusted host worker for the named fixed host from the existing
`CONFIG-NATIVE-QEMU-001` connection file. `dim ci native-qemu scheduler image
build IMAGE` builds the scheduler service image. These commands do not start,
configure, inspect, or fall back to Gitea or ordinary CI.

`dim ci native-qemu event status EVENT_ID CONFIG` reads the durable queue,
claim, attempt, and terminal-result state through the distinct query
credential. The removed `dim ci native-qemu project admit` command is obsolete
and must not remain as an alias. The scheduler automatically reconciles every
registered native Project and native Git sends exact stored QEMU candidate
events with its distinct event-intake credential. It does not call the ordinary
event endpoint or reuse ordinary markers.

`dim ci native-qemu runner image build IMAGE` builds the trusted KVM runner
with the fixed `/usr/local/bin/dim-native-qemu-run` launcher. The host mounts
the configured digest-pinned job image read-only as the guest root; candidate
script and descriptor bytes enter the guest through a separate read-only 9p
mount. The launcher provides no network device or reusable credential.

The target scheduler file is strict schema `2` and contains exactly `schemaVersion`,
`serviceId`, `host`, `port`, `database`, `eligibilityLeaseMilliseconds`,
`claimLeaseMilliseconds`, `nativeGit`, `credentials`, and `hosts`.
`serviceId` is `qemu-main`; `database` is an absolute private path; internal
eligibility and claim leases are positive and the claim lease is at least 60
seconds. Eligibility lease expiry causes automatic reconciliation, not an
operator refresh.
`nativeGit` contains one exact HTTP(S) origin, service ID `native-main`, and
pairwise-distinct `identity`, `attemptIssuer`, `candidateReader`, and
`resultReporter` Basic
credentials. `credentials` contains pairwise-distinct `eventIntake` and `query`
credentials. Each host has one unique `hostId`, one
unique canonical 32-byte base64url `hostToken`, and one or more uniquely named
capacities. Each capacity fixes digest-pinned runner/job images and positive
CPU, memory-byte, PID, wall-clock-second, and output-byte bounds. Every
username, password, host token, readiness token, and activation token is
globally distinct.

The scheduler executable accepts `check-config CONFIG`, `serve CONFIG`, and
`compatibility --json`. The host command performs functional KVM preflight
before attestation or claim, both on the host and inside every configured
digest-pinned runner image after requiring its trusted launcher. Missing,
non-character, unreadable, unwritable, or nonfunctional `/dev/kvm`, an absent
launcher or QEMU executable in the trusted runner image, or failure of
`-enable-kvm` is reported as `unavailable`; it creates no terminal job result
and does not request ordinary work.

## Boundary and authority

Native QEMU is a separate authenticated service, database, scheduler, host
capacity, and VM executor. It is not a third member of the native Git/ordinary
CI Compose bundle, the predecessor Gitea `workflow-job` scheduler, or an
ordinary Sysbox result alias. No Project-specific runner registration, Gitea
organization, Actions webhook, label set, approval, or API/webhook token is
required. Trusted native Project registration makes the Project eligible for
QEMU independently of its quality policy; the
operator configures global host capacities and digest-pinned common runner
and job base images. Candidate bytes cannot select an image or capacity.

The host connection is the exact schema in `CONFIG-NATIVE-QEMU-001`. A separate
operator-owned target scheduler configuration has schema version `2`, service ID
`qemu-main`, its own private database path, positive internal eligibility and claim lease
durations (the claim lease is at least 60 seconds), and an exact native Git
service origin and ID. It contains distinct credentials for native Git policy
and stored-event identity proof, current-attempt issuance/revocation, and
terminal-result reporting; separately scoped QEMU event-intake and query
identities; and an array of host IDs, unique host tokens, and named
capacities with the same pinned images and bounds the participating host
attests. No Project map or credential enters native Project state. Scheduler,
host, ordinary, native Git, and predecessor tokens are pairwise distinct.

The private host connection additionally fixes `supervisorMemoryBytes` for
each capacity. It is strictly greater than descriptor `memoryBytes`: Docker
enforces the former on the trusted outer supervisor, while the launcher derives
QEMU guest RAM only from the latter. This reserves explicit operator-selected
overhead instead of placing QEMU in a container capped at exactly guest RAM.

| Credential | Only allowed authority |
| --- | --- |
| QEMU host token | Attest one host and claim, renew, recover or report only its named capacities |
| QEMU event intake | Receive a native Git event for an exact QEMU review job, never executable input |
| QEMU query | Read exact current eligibility and attempt tuples |
| Native Git QEMU identity | Read the exact protected policy and stored review-event proof |
| Native Git QEMU issuer | Derive one QEMU descriptor and issue/revoke its current exact attempt |
| Native Git QEMU candidate reader | Mint only an ephemeral smart-HTTP read lease for one current exact QEMU assignment |
| Native Git QEMU reporter | Submit only the exact terminal QEMU result |

None is a Git reader/writer, human reviewer, promoter, host-admin, ordinary
CI, or general scheduler super-token. The host derives its identity from the
token, not a claim body. No reusable credential crosses into a disposable VM,
job, cloud-init file, workspace, log, or Project record.
No QEMU credential, runner, scheduler, supervisor, or result can approve a
review, promote a protected ref, or make a Project or workspace ready.

## Candidate, attempt, and proof tuple

The protected policy names promotion-required jobs by the **pair** `(executionKind,
jobName)` with `executionKind` exactly `ordinary-sysbox` or `qemu` and
`evidenceClass` exactly `candidate-controlled`. Required QEMU and ordinary
names are distinct during the pre-stable transition from flat native Git job
names. The kind is bound into policy and required-job-set revisions and MUST
be derived from authenticated current policy, never supplied by a webhook.

The target unified candidate file is strict schema `4` `.dim/ci/runner.yml`.
It has top-level `schemaVersion` plus exactly the nonempty execution-kind
sections selected by the candidate: `ordinary`, `qemu`, or both.
Each present section contains exactly a `jobs` map. Every named job contains
only `script` and the runtime-fixed
`argv` of `[/bin/bash, --noprofile, --norc, /run/dim/job/script]`. The name
sets are independent of the policy's ordinary and QEMU `requiredJobs` subsets.
A candidate with no jobs needs no CI file or result. Extra valid candidate jobs
run and remain visible evidence, while a missing policy-required job blocks
only promotion.
The parser rejects images, bounds, mounts, environment, network, URL, host
command, credential, extra argv, unsafe script paths, non-regular Git blobs,
unknown/duplicate YAML fields, aliases/tags and unsupported schemas. Both
config and script identities come from the **exact candidate commit/tree**;
both results remain candidate-controlled self-test evidence. The exported
schema-4 parser validates supplied bytes and returns their strict kind-labelled
candidate jobs. The separate native-Git library reader does not filter those
names through the registered protected policy. It pins
the repository, protected head, candidate commit and tree; reads the config and every selected
ordinary/QEMU script as bounded regular blobs; rechecks the protected head after
all reads; and returns only object IDs, SHA-256 digests, safe paths, kind-labelled
job names, and fixed argv. It supports SHA-1 and SHA-256 repositories and has no
scheduler, executor, admission, image, bounds, host, capacity, credential,
attempt, result, or VM authority. The registered standalone policy does not bind
execution kinds, so that API remains caller-trusted for kind labels. A distinct
internal reader accepts only the trusted activated bundle runtime, Project, and
candidate commit/tree. It derives owner and protected ref/head from a fully
live-verified durable `authoritative-v1` imported-root row,
repeats activation and complete owner/bundle/ref/graph proof after candidate
blob reads, and rejects quarantined `legacy-import-only` rows. It is not an
installed route or lifecycle/policy admission adapter and creates no state.
The separately active ordinary-only schema-3 parser and loader remain unchanged
and are not a native-QEMU compatibility path after schema 4 is enabled.

The installed native-Git bundle also exposes a trusted in-process, read-only
QEMU descriptor method. It accepts only a Project, immutable candidate
envelope, candidate job name, and explicitly operator-trusted execution
generation, digest-pinned
job and runner images, and positive bounds. It reconstructs the exact current
envelope before and after the authoritative schema-4 candidate reads, requires
the candidate plan to label the job `qemu`, and returns a strict schema-1
descriptor with `executionKind: qemu`,
`evidenceClass: candidate-controlled`, exact config/script identities, fixed
argv, and the QEMU-only `dim-native-qemu-execution-v1` digest. It has no HTTP
route, QEMU credential, admission, scheduler, attempt, result, VM, promotion,
ref-write, or Project-readiness authority. An ordinary descriptor or result is
not accepted as QEMU evidence.

The imported-root native review event uses schema version `2`, separate from
the standalone ordinary-only event contract. An event from native Git carries exactly schema/version, event ID, kind
`qemu`, job name, Project/repository/protected ref, review ID, expected
protected head, candidate commit/tree, three current policy revisions, and
`candidate-controlled` class. It carries no script, image, argv, bounds,
host, capacity, URL or credential. QEMU intake verifies the immutable stored
candidate-job event and current registered Project tuple before recording
demand. The policy tuple is retained for promotion provenance, not eligibility.

Each successful workspace proposal create or fast-forward causes native Git to
reconcile the exact candidate envelope and enqueue all declared QEMU jobs. No
promoter or reviewer action is needed. Scheduler restart, generation rollover,
lease expiry, and native-Git outage trigger internal reconciliation and durable
retry, never a per-Project admission or refresh. Old claims remain fenced until
the same host completes ownership-safe cleanup.
Fresh proof of the same Project eligibility renews its stable internal
generation after cache expiry. A definitive native authority `404` or `409`
during issuance terminally supersedes that queue head and releases its
reservation so later valid work can progress. A `502`, timeout, cancellation,
or transport failure is transient: the exact reservation remains retryable and
is not reclassified as stale.

Successful event intake returns a strict schema-2 acknowledgement containing
`qemu-main`, the scheduler's database-persisted service-generation UUID, the
stable eligibility generation, and its exact finite deadline. Native Git stores
that tuple in a strict schema-3 event/digest marker bound to a non-secret digest
of the configured scheduler destination. Deadline expiry or destination change
automatically redelivers the identical event; scheduler primary keys make the
refresh idempotent. Definitive authenticated `404` or `409` intake rejection is
stored as destination-bound supersession with a finite retry deadline so stale
work cannot head-of-line block newer events. Expiry retries the same immutable
event at the same destination, and a durable acknowledgement replaces the same
marker path. The scheduler database is strict schema 3 and rejects schema 2
unchanged rather than migrating it.

Each claim binds the current internal execution generation, event, review, ref/head,
candidate commit/tree, policy/review/job-set revisions, execution kind `qemu`,
job name, candidate config/script blob IDs and SHA-256 digests, exact fixed
argv, operator runner/job base digests, resource/time/output bounds, host,
capacity and a new UUID claim/attempt/resource identity. The descriptor hash
uses its own length-framed ASCII domain `dim-native-qemu-execution-v1`; it
cannot reuse the ordinary descriptor's domain. A successful ordinary attempt
for the same job name or commit is **not** a QEMU attempt.

## Dedicated wire paths and durable cleanup

The separate service exposes exact `POST /v1/qemu-events` to the QEMU event
identity, `GET /v1/qemu-host-identity` to the host token, and distinct
`POST /v1/qemu-host-claims`, `/v1/qemu-host-claim-renewals`,
`/v1/qemu-host-recoveries`, `/v1/qemu-host-candidate-leases`, and
`/v1/qemu-host-results` to that token. All
requests use a strict schema version, fresh request UUID, and the applicable
kind, capacity, claim, attempt and descriptor identities. The service derives
the host from authentication; responses echo the exact service, request,
kind, claim and lease or result tuple. No route accepts a Gitea event, label,
Project API token, arbitrary host command or caller-selected image. The
candidate-lease request names only the current claim, attempt, and descriptor
digest. The scheduler derives the authenticated host, configured capacity, and
complete active assignment from its database, then asks native Git with its
QEMU-only `candidateReader` credential. Native Git verifies the current
unrevoked QEMU attempt and exact descriptor, digest, host, capacity, Project,
root repository, protected ref/head, candidate commit/tree, review, job, and
kind before minting an in-memory lease of at most 30 seconds. It repeats this
proof before every upload-pack invocation and denies replacement, revocation,
expiry, drift, receive-pack, or a foreign route before Git starts. The lease is
never written to scheduler state, the host journal, guest state, or evidence.
This path cannot forward a filesystem path, command, URL, SSH target, arbitrary
HTTP request, backend credential, or script bytes. The native
Git QEMU issuance, report and current-attempt verification routes use only
their distinct QEMU credentials and never enter ordinary inbox, claim,
attempt, result or report-outbox tables.

At most one attempt is current per `(Project, repository, protected ref,
review, execution kind, job name)`. One UUID claim is the issuance-request
and exact owned-resource identity. Exact retries converge on the same attempt;
changed requests and stale generations conflict. A terminal result becomes
promotable only after its matching current attempt, exact descriptor, bounded
execution evidence, and complete VM cleanup are durable. The scheduler owns
independent inbox, replay fence, leases, capacity fences, assignments,
results and report outbox in its own database; its reporter retries the
unchanged terminal event to a QEMU-only native Git route. Result kind and
class are derived from the authenticated attempt, not a claim or candidate.

The trusted host supervisor alone has `/dev/kvm`. Before releasing a claim it
must inspect, stop and reap **only** its exact owned QEMU process, supervisor
container, overlay and seed disks, sockets, temporary data, and disposable
guest runtime. Uncertain renewal or partial/foreign residue fences only that
capacity until the same host proves cleanup. The guest receives the pinned
images and checked-out candidate bytes but no host socket, `/dev/kvm`, raw
Git/DIM/QEMU credential, reviewer or promotion authority. Missing or stale
functional KVM availability is `unavailable`, never a job result, a QEMU pass,
or an ordinary fallback. A protected QEMU requirement remains unsatisfied.

Each operator-selected, digest-pinned job image MUST provide `/bin/bash` and
pre-create `/dev`, `/proc`, `/sys`, `/run/dim/job`, and `/workspace` as
directories, plus `/tmp` as a directory. The trusted initramfs enables the
guest cgroup-v2 `pids` controller, creates the bounded leaf, and moves PID 1
into that leaf before candidate execution. It mounts the verified descriptor and script read-only
at `/run/dim/job`, mounts the exact verified candidate tree read-write at
`/workspace`, mounts a fresh writable `nosuid,nodev` tmpfs at `/tmp`, and
exposes `/proc` and `/sys` read-only inside the job root. A root-owned static
launcher chroots, changes to `/workspace`, clears supplementary groups, drops
to fixed UID/GID `1000:1000`, enables `no_new_privs`, and executes exactly
`/bin/bash --noprofile --norc /run/dim/job/script`. The candidate cannot write
the governing cgroup files or regain root through set-ID or file-capability
executables. Bash and any additional
job runtime, including an optional guest-local container engine, belong to the
job image; no host runtime socket, transport credential, or KVM device is
passed through to the job image.

Before scheduler attestation, the host uses Docker to mount each job image with
`type=image` into its paired trusted runner image and verifies `/bin/bash` plus
all required directories through that real mount. A Docker daemon without
image-mount support or an incompatible job image is unavailable before any
claim. This trusted runc supervisor does not require or inspect `sysbox-runc`;
Sysbox remains an ordinary-CI prerequisite only. The host also acquires an
exclusive kernel lock for every configured capacity before any capacity may
attest or claim, releases every earlier lock if the set cannot be acquired, and
holds each lock through replay, cleanup, reporting, and shutdown.

Parser tests and simulated claims are **not** acceptance. Native QEMU deployment
and fresh-host Gitea removal require the packaged two-executor clean-host
journey with real Sysbox and accessible KVM in
`VERIFICATION-NATIVE-CUTOVER-001`. Native Project and workspace readiness has
its own prerequisites and MUST NOT wait for this optional quality capacity.
