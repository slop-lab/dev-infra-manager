# Native QEMU Scheduler and Evidence

**Kind: Implementation profile**

**Status: Host-file preflight, schema-4 candidate parsing, native-Git standalone and authoritative imported-root candidate readers, and an internal read-only authoritative QEMU descriptor prerequisite are implemented; Gitea-free scheduler, lifecycle/policy admission adapter, host adapter and runtime are not implemented.**

## Boundary and authority

Native QEMU is a separate authenticated service, database, scheduler, host
capacity, and VM executor. It is not a third member of the native Git/ordinary
CI Compose bundle, the predecessor Gitea `workflow-job` scheduler, or an
ordinary Sysbox result alias. No Project-specific runner registration, Gitea
organization, Actions webhook, label set, approval, or API/webhook token is
required. Only the trusted native lifecycle makes an eligible Project; the
operator configures global host capacities and digest-pinned common runner
and job base images. Candidate bytes cannot select an image or capacity.

The host connection is the exact schema in `CONFIG-NATIVE-QEMU-001`. A separate
operator-owned scheduler configuration has schema version `1`, service ID
`qemu-main`, its own private database path, positive admission and claim lease
durations (the claim lease is at least 60 seconds), and an exact native Git
service origin and ID. It contains distinct credentials for native Git policy
and stored-event identity proof, current-attempt issuance/revocation, and
terminal-result reporting; separately scoped QEMU event-intake, registrar and
query identities; and an array of host IDs, unique host tokens, and named
capacities with the same pinned images and bounds the participating host
attests. No Project map or credential enters native Project state. Scheduler,
host, ordinary, native Git, and predecessor tokens are pairwise distinct.

| Credential | Only allowed authority |
| --- | --- |
| QEMU host token | Attest one host and claim, renew, recover or report only its named capacities |
| QEMU event intake | Receive a native Git event for an exact QEMU review job, never executable input |
| QEMU registrar | Attest and revoke a trusted native Project policy without Project-specific approval |
| QEMU query | Read exact current admission and attempt tuples |
| Native Git QEMU identity | Read the exact protected policy and stored review-event proof |
| Native Git QEMU issuer | Derive one QEMU descriptor and issue/revoke its current exact attempt |
| Native Git QEMU reporter | Submit only the exact terminal QEMU result |

None is a Git reader/writer, human reviewer, promoter, host-admin, ordinary
CI, or general scheduler super-token. The host derives its identity from the
token, not a claim body. No reusable credential crosses into a disposable VM,
job, cloud-init file, workspace, log, or Project record.

## Candidate, attempt, and proof tuple

The protected policy names required jobs by the **pair** `(executionKind,
jobName)` with `executionKind` exactly `ordinary-sysbox` or `qemu` and
`evidenceClass` exactly `candidate-controlled`. Required QEMU and ordinary
names are distinct during the pre-stable transition from flat native Git job
names. The kind is bound into policy and required-job-set revisions and MUST
be derived from authenticated current policy, never supplied by a webhook.

The target unified candidate file is strict schema `4` `.dim/ci/runner.yml`:
top-level `schemaVersion`, `ordinary`, and `qemu`, each containing exactly a
`jobs` map. Every named job contains only `script` and the runtime-fixed
`argv` of `[/bin/bash, --noprofile, --norc, /run/dim/job/script]`. The name
sets MUST equal the policy's corresponding ordinary and QEMU required sets.
The parser rejects images, bounds, mounts, environment, network, URL, host
command, credential, extra argv, unsafe script paths, non-regular Git blobs,
unknown/duplicate YAML fields, aliases/tags and unsupported schemas. Both
config and script identities come from the **exact candidate commit/tree**;
both results remain candidate-controlled self-test evidence. The exported
schema-4 parser validates supplied bytes against trusted kind-labelled required
jobs. The separate native-Git library reader requires the supplied job names
to match the registered protected policy's flat required-name set, then pins
the repository, protected head, candidate commit and tree; reads the config and every selected
ordinary/QEMU script as bounded regular blobs; rechecks the protected head after
all reads; and returns only object IDs, SHA-256 digests, safe paths, kind-labelled
job names, and fixed argv. It supports SHA-1 and SHA-256 repositories and has no
scheduler, executor, admission, image, bounds, host, capacity, credential,
attempt, result, or VM authority. The registered standalone policy does not bind
execution kinds, so that API remains caller-trusted for kind labels. A distinct
internal reader accepts only the trusted activated bundle runtime, Project, and
candidate commit/tree. It derives owner, protected ref/head, and required job
kinds from a fully live-verified durable `authoritative-v1` imported-root row,
repeats activation and complete owner/bundle/ref/graph proof after candidate
blob reads, and rejects quarantined `legacy-import-only` rows. It is not an
installed route or lifecycle/policy admission adapter and creates no state.
The separately active ordinary-only schema-3 parser and loader remain unchanged
and are not a native-QEMU compatibility path after schema 4 is enabled.

The installed native-Git bundle also exposes a trusted in-process, read-only
QEMU descriptor method. It accepts only a Project, immutable review, required
job name, and explicitly operator-trusted admission generation, digest-pinned
job and runner images, and positive bounds. It reconstructs the exact current
review before and after the authoritative schema-4 candidate reads, requires
both imported policy/review evidence and the candidate plan to label the job
`qemu`, and returns a strict schema-1 descriptor with `executionKind: qemu`,
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
review-job event and current Project/policy tuple before recording demand.

Each claim binds the current admission generation, event, review, ref/head,
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
`/v1/qemu-host-recoveries`, and `/v1/qemu-host-results` to that token. All
requests use a strict schema version, fresh request UUID, and the applicable
kind, capacity, claim, attempt and descriptor identities. The service derives
the host from authentication; responses echo the exact service, request,
kind, claim and lease or result tuple. No route accepts a Gitea event, label,
Project API token, arbitrary host command or caller-selected image. The native
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

Parser tests and simulated claims are **not** acceptance. Native readiness and
fresh-host Gitea removal require the packaged two-executor clean-host journey
with real Sysbox and accessible KVM in `VERIFICATION-NATIVE-CUTOVER-001`.
