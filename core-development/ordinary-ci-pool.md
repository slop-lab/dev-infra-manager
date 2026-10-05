# Native ordinary CI control plane

This is the target implementation and operator design for the ordinary CI
scheduler/webhook service installed with native Git. Core now includes the
bounded native authority, standalone webhook intake, and receipt-bound host
claim activation described below; renewal, recovery, result delivery,
controller execution, and installer deployment remain unimplemented.
The normative authority,
admission, and installer transaction are in
`specification/specs/10-cli-contract.md` and
`specification/specs/14-installer-facade.md`.

The shipped Gitea predecessor still provides `dim ci ordinary-pool service
run CONFIG` and `dim ci ordinary-pool project reconcile PROJECT
REGISTRAR_CONFIG`; its standalone `worker` commands have been removed in favor
of managed-controller supervision. Those commands, schema-2 databases, and
persistent Project-scoped Sysbox runners are not the native target and are
rejected only after that target replaces the predecessor. Do not deploy this
topology or claim its acceptance gates until the remaining service and host
controller implementation passes the referenced verification.

## Ownership matrix

| Concern | Owner | Explicitly not owner |
| --- | --- | --- |
| Compose deployment, image digests, fixed mounts, ports, readiness, rollback | installer facade | operational CLI |
| Bare repositories, proposal transport, review and exact CI evidence, protected promotion | native Git service | ordinary scheduler, host controller |
| Operator-authorized Project admission, webhook demand, attempts, queue, claim leases | ordinary CI service | trust in candidate job bytes, native Git storage, host runtime |
| Shared capacity, Sysbox execution, cleanup, result submission | each DIM host controller | Compose services, Project lifecycle |
| Candidate ordinary image, fixed argv, and script | exact candidate Git tree for one disposable job | admission authority, persistent runner/image state |
| Runner base and resource/time/output ceilings | operator-owned host capacity | candidate config or webhook |
| QEMU integration demand and execution | optional QEMU scheduler and host QEMU supervisors | ordinary CI service |

Neither control-plane service receives a host Docker socket, controller socket,
`/dev/kvm`, or generic remote-execution capability. A scheduler lease is
permission for one authenticated host controller to attempt one admitted job;
it is not a runtime control channel.

## Service-private state

The Compose project is exactly `dim-control-plane`. The `native-git` service
runs as `10001:10001`, mounts only
`dim-control-plane-native-git-data:/var/lib/dim-native-git`, and listens on
container port `8080`. The `ordinary-ci` service runs as `10002:10002`, mounts
only `dim-control-plane-ordinary-ci-data:/var/lib/dim-ordinary-ci`, and also
listens on its own container port `8080`. Compose publishes each to the distinct
host address and port in the installer config. The only shared resource is the
fixed `dim-control-plane` bridge network.

The native volume contains bare repositories and immutable review, attempt,
result, and promotion evidence. The ordinary volume contains
`ordinary-ci.sqlite3` plus SQLite-owned `-wal` and `-shm` files. It contains no
repository bytes, image layer, runner work directory, registration data, or
Project checkout. This contract grants the installer no backup, export, restore,
or data-conversion authority over either volume.

Compose resources carry these exact labels in addition to Compose's own labels:

```text
org.dim.managed=true
org.dim.bundle=control-plane
org.dim.deployment=<deploymentId>
org.dim.resource=network|volume|service
org.dim.service=native-git|ordinary-ci
```

The network omits `org.dim.service`. A service volume and container include the
matching service value. Missing, malformed, partial, foreign, or mismatched
labels are conflicts. Installation, update, rollback, and removal act only on
the immutable container ID or exact volume/network name returned by a
successful complete-label inspection. The installer never adopts, relabels, or
deletes a conflict.

## Private service configuration

The operator supplies DIM-user-owned mode-`0600` service JSON and readiness
token source files. The installer descriptor-validates and copies them into one
immutable generation directory, then mounts the mode-`0444` snapshots at
`/run/secrets/service.json` and `/run/secrets/readiness.token`. It separately
generates and snapshots one service-specific activation token at
`/run/secrets/activation.token`. Mutable operator paths are never mounted. The
mode-`0700` DIM-owned generation directory prevents host traversal while the
individual bind mounts remain readable by the fixed service UID. The generated
Compose file contains snapshot paths but no secret bytes.

The ordinary service JSON is strict schema `3`:

```json
{
  "schemaVersion": 3,
  "serviceId": "ordinary-main",
  "listen": { "host": "0.0.0.0", "port": 8080 },
  "database": "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3",
  "nativeGit": {
    "endpoint": "http://native-git:8080",
    "serviceId": "native-main",
    "identity": {
      "username": "ordinary-identity",
      "password": "replace-with-identity-credential"
    },
    "attemptIssuer": {
      "username": "ordinary-attempts",
      "password": "replace-with-attempt-issuer-credential"
    },
    "resultReporter": {
      "username": "ordinary-results",
      "password": "replace-with-result-reporter-credential"
    }
  },
  "credentials": {
    "webhook": {
      "username": "native-events",
      "password": "replace-with-webhook-only-credential"
    },
    "query": {
      "username": "native-main",
      "password": "replace-with-query-only-credential"
    }
  },
  "leaseSeconds": 60,
  "admissionLeaseSeconds": 300,
  "hosts": {
    "host-a": {
      "hostToken": "replace-with-host-token",
      "admissionToken": "replace-with-admission-token",
      "capacities": {
        "primary": {
          "runnerBaseImage": "registry.example/dim/ordinary-runner@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "bounds": {
            "cpu": "4",
            "memoryBytes": "8589934592",
            "pids": "2048",
            "wallClockSeconds": "3600",
            "outputBytes": "16777216"
          }
        }
      }
    }
  }
}
```

`listen` and `database` must equal the fixed deployment values. The native Git
endpoint is exactly the Compose-network origin above and follows no redirect.
It is not operator-selectable or derived from a request. Plaintext peer
authentication is valid only while both services remain the sole members of
the exclusive `dim-control-plane` bridge; the peer endpoint is not published as
a shared-host trust claim.
Ordinary `/readyz` validates only its immutable config snapshot, local database
readability and durability, and local listener; it neither contacts native Git
nor requires Project state. Every token and native-facing password is distinct,
base64url, and at least 32 random bytes.
The host map contains installation capacity identities and bounds only; it
contains no Project, repository, candidate job image, label, or Git credential.
Each named capacity selects one digest-pinned runner base and positive canonical
decimal CPU, memory, PID, wall-clock, and output ceilings. The host connection
must repeat the same values exactly, but it cannot create or widen capacity.
Adding or removing a host
is a reviewed operator-source update that creates a new immutable bundle
generation, not a service API.

The native Git service config is strict schema `2`, pins `serviceId` to
`native-main`, and otherwise follows the native Git transport profile. For this
deployment its listener and storage root
must be `0.0.0.0:8080` and `/var/lib/dim-native-git`; it must name the exact
ordinary service origin `http://ordinary-ci:8080`, service identity, and a
distinct query-only dependency credential plus the fixed native-event webhook
endpoint and credential. Its Git
transport, reviewer, administrator, and promoter credentials do not appear in
the ordinary config. The installer invokes each image's `dim-service
check-config` before mutation, so cross-service identity, fixed path, token
distinctness, and schema failures are preflight failures.

The native query credential may read only the exact current admission and
attempt status needed by native promotion checks. The webhook credential may
only create the exact non-executable inbox event. The ordinary identity
credential may read only exact configured native service,
repository/protected-policy, and current issued-attempt proofs. Native policy
proof contains no host or capacity selector. All admitted Projects share every
capacity in the ordinary service's operator-owned global `hosts` configuration.
No Project policy, admission row, native proof, webhook, or request stores or
selects a per-Project eligible-assignment list.
The attempt-issuer credential may derive the strict descriptor and issue or
revoke only a current receipt-bound attempt for an exact live ordinary
admission tuple, required job, host, and capacity; it cannot report a result,
read Git, approve, promote, or administer. The result-reporter credential may report only the terminal
result for that exact current attempt and job; it cannot issue or revoke.
Neither credential can read Git, approve, promote, administer storage,
enumerate unrelated Projects, or act before the native identity check for that
operation succeeds.

Webhook, query, native identity, attempt issuer, result reporter, and each host
credential are pairwise distinct. Admission credentials are also distinct from
all six roles. Role crossover is denied even when a request body names a tuple
that the other role could use. None of these credentials enters a claim, job,
image, checkout, log, Project record, or native event.

The paired native client contract is documented under "Ordinary verifier HTTP
contract" in the native Git transport profile. In particular, ordinary returns
the exact query role and ordered scope at identity attestation, and echoes the
fresh request nonce plus the complete verified tuple on successful admission or
current-attempt queries. It returns no credentials or unrelated Project, host,
capacity, attempt, or repository inventory.

The nonce correlates one response to one request and rejects an offline replay;
it does not authenticate an active endpoint that can reflect the request. The
target deployment therefore treats the fixed private Compose bridge, fixed
service origin, and service-to-service Basic credential as the peer-
authentication boundary. It does not claim cryptographic server identity on
plain HTTP outside that private network. A deployment that cannot preserve this
exclusive network assumption requires authenticated transport before use.

## Implemented authority and webhook-intake library

`@slop-lab/dim-core` exports `configuredNativeOrdinaryAuthorityServer` as a
native-only HTTP and SQLite library. It is not wired to the CLI, installer,
native Git sender, or host controller. Its normalized configuration is strict
schema `3` and contains one service ID, a dedicated database path, admission and
claim leases, separate Basic credentials for `webhook`, `registrar`, and
`query`, one distinct token per host, and the operator-owned host capacities.
Each capacity fixes its host and
capacity IDs, digest-pinned runner base, and maximum CPU, memory, PID,
wall-clock, and output bounds. Credential passwords are distinct base64url
values of at least 32 characters. The library receives no Git, Docker,
controller, or host-administration socket.

Native-backed mutation routes are additionally gated by the configured native
Git HTTP `NativeAdmissionSource`. Tests may replace only its HTTP transport; no request,
Project, or runtime configuration selects another source. The adapter lazily
authenticates and attests the configured native Git service on the first
mutation, bounded to five seconds, so central listener startup does not wait for
native Git. The interface returns canonical native values from
`assertRegisteredPolicy`, `assertReviewEvent`, and `assertIssuedAttempt`; the
service parses those returned values again and
persists them instead of registrar or host assertions. The production
adapter uses the dedicated read-only policy, stored review-event, and
issued-attempt proof endpoints,
requires the exact role, ordered scope, service ID, fresh nonce, and complete
tuple, follows no redirect, and performs no retry. A source rejection is
concealed as not found, while an unavailable or malformed peer is service
unavailable. Both outcomes precede SQLite mutation.

The database uses SQLite `user_version = 3`, WAL, full synchronous durability,
and the compiled final manifest for admissions, service epochs, current attempt
assignments, permanent event and review/job replay fences, event inbox, demand,
claim receipts, claims, capacity fences, host results, report outbox, and
terminal details.
Schema-less, schema-1, and predecessor schema-2 files are inspected read-only
and rejected without mutation. There is no compatibility shim or migration
through the Gitea ordinary-pool schema-2 store.

The service MUST NOT infer compatibility from `PRAGMA user_version = 3`.
Startup compares
the complete table, index, column, foreign-key, unique, and check-constraint
shape against the compiled final schema while opened read-only, then runs SQLite
integrity and foreign-key checks. It rejects both the former authority-only
two-table shape and the unreleased six-table intake shape byte-for-byte before
WAL. Because neither partial shape shipped, there is no migration or dual reader.

The webhook credential has only exact `POST /v1/native-events`. The route
strictly parses the schema-1 non-executable event, rereads the exact canonical
stored event from native Git, requires a matching live admission, and commits the inbox row,
queued demand, and both permanent replay fences in one `BEGIN IMMEDIATE`
transaction before returning `202`. Exact event replay and a new-ID alias for
the same tuple return `202` without reopening demand, including after restart
or detailed-row retention time. Changed reuse conflicts. Each fence table is
capped at 100,000 rows; known replay bypasses saturation while unseen input is
rejected before mutation. Admission rotation or revocation supersedes queued
old-generation demand under G1. Webhook handling performs no
descriptor derivation, attempt issuance, claim, Docker operation, or execution.

The registrar credential has only these mutation surfaces:

- `POST /v1/operator-admissions` parses a strict schema `1` policy request:
  Project and repository IDs, protected ref, policy/review/job-set revisions,
  the exact required job set. It
  persists only the canonical policy returned by
  `NativeAdmissionSource.assertRegisteredPolicy`. For that canonical policy, an
  identical active refresh retains its generation; expiry or any policy change
  produces a new UUID generation. The response contains the canonical service
  and policy identity, generation, and expiry, but no credential.
- `POST /v1/operator-admission-revocations` removes only the exact current
  Project, repository, and generation tuple. A stale or foreign tuple is
  concealed as not found.

Each host token has only exact `POST /v1/host-claims` for its configured
capacities. The service first commits a durable preparing receipt and reserves
the oldest current-generation demand. With no SQLite transaction open, it uses
that receipt UUID as the native issuance request ID to derive and issue the
attempt, then obtains strict native issued-attempt proof. A second immediate
transaction revalidates the receipt, demand, admission, capacity digest,
service epoch, descriptor, and proof before publishing the active claim and
current assignment together. The former public
`POST /v1/current-attempt-assignments` scheduler route does not exist.

The query credential has only `GET /v1/identity`,
`POST /v1/admission-verifications`, and
`POST /v1/current-attempt-verifications`. Identity returns the exact
`native-query` role and ordered `admission:read`, `attempt:read` scope expected
by the Native Git client. Successful verification returns exact HTTP 200
`application/json`, `Cache-Control: no-store`, the configured service ID,
`authorized: true`, and the fresh request nonce plus complete request tuple.
The nonce is echoed only after the durable state check. It is correlation, not
peer authentication. Denial is a non-200 not-found response containing no
verified tuple, inventory, or secret.

Bodies are capped at 64 KiB and must use exact JSON content type and fields.
The listener has bounded request, header, keep-alive, and per-socket request
limits. Rotation, revocation, expiry, assignment replacement, restart, wrong
role, foreign host/capacity, descriptor drift, and stale generation all fail
closed.

## Final schema-3 scheduler target

`CI-NATIVE-DELIVERY-001` replaces the authority-only database shape above with
the final schema-3 scheduler shape. This is specification for future source,
not a claim about current code. IDs are lowercase UUID text, digests use the
named `sha256:` form, JSON columns contain validated canonical compact JSON,
and all times are positive Unix milliseconds. The compiled schema contains
exactly these application tables and indexes:

| Table | Primary and unique identity | Required payload |
| --- | --- | --- |
| `service_epochs` | `epoch_id` primary key; one partial-unique `active = 1` row | `started_at`, `active` constrained to `0|1` |
| `native_admissions` | `admission_generation` primary key; one partial-unique active row per Project/repository | service, Project, repository, protected ref, three policy revisions, policy and capacity-config digests, canonical policy JSON without a host/capacity array, expiry, `active|expired|revoked|replaced` state, created/updated times |
| `native_event_replay_fences` | `event_id` primary key | `event_digest`; never age-pruned |
| `review_job_replay_fences` | `(review_id, job_name)` primary key | domain-separated `tuple_digest`; never age-pruned |
| `native_event_inbox` | `event_id` primary key; `event_digest` unique | canonical event JSON, complete event tuple, optional `demand_id`, `accepted|terminal` state, received and terminal times |
| `demands` | `demand_id` primary key; one partial-unique nonterminal row per review/job | event ID, review tuple, admission generation, `queued|preparing|claimed|reported|completed|superseded|cancelled|failed` state, created/updated/terminal times |
| `claim_receipts` | `claim_id` primary key; `(host_id, capacity, request_id)` unique | optional demand ID unique, optional admission generation, `empty|preparing|active|reported|recovering|released` state, created/updated/released times |
| `claims` | `claim_id` primary key; `demand_id` and `attempt_id` unique | host, capacity, event/review/job, generation, native attempt, descriptor JSON/digest, lease expiry, issuing service epoch, `active|reported|recovering|released` state |
| `capacity_fences` | `(host_id, capacity)` primary key | claim ID unique, `lease-lost|generation-rotated|service-restart|foreign-resource` reason, created time |
| `native_attempt_assignments` | `(review_id, job_name)` primary key; `attempt_id` unique | claim ID unique, descriptor digest, generation, host, capacity |
| `host_results` | `claim_id` primary key; `(host_id, request_id)` unique | attempt and descriptor identities, canonical terminal event JSON/digest, cleanup acknowledgement, created time |
| `report_outbox` | `claim_id` primary key | terminal event JSON/digest, `pending|delivering|delivered|denied` state, attempt count, next-attempt time, optional fixed safe denial code, created/updated times |
| `terminal_details` | `(kind, object_id)` primary key | digest, terminal state, created time; age-prunable only while both replay fences survive |

Event acceptance inserts the inbox/demand and both replay fences in one
transaction. Each replay-fence table is capped at 100,000 rows. A known exact
event or tuple replay bypasses the cap and returns the original acceptance; an
unseen value requiring a new row returns `429` before any mutation. There is no
age-based, pressure-based, or last-seen-based fence deletion.

Every relationship above is a non-null foreign key except an accepted inbox
event's initially null `demand_id` during the same event-acceptance transaction.
That transaction must fill it before commit. State names are exact `CHECK`
values. Cleanup is exact integer `1`; no false value is persisted. Partial
indexes select oldest `queued` demand by `(created_at, demand_id)`, due report
rows by `(next_attempt_at, claim_id)`, and one active admission and nonterminal
review/job as stated above. Foreign keys use `ON DELETE RESTRICT`. Terminal
pruning deletes only detailed rows whose complete dependency closure is terminal
and at least seven days old and whose event and review-job replay fences already
exist and survive the transaction. Replay fences have no age or last-seen field
and are never pruning candidates. The service uses `BEGIN IMMEDIATE` for event acceptance,
claim selection/receipt publication, assignment plus claim activation, result
plus outbox publication, report completion/release, generation rotation, and
recovery release.

Startup reads `sqlite_schema`, every `PRAGMA table_info`, `index_list`,
`index_info`, and `foreign_key_list` result, plus the exact normalized `CREATE
TABLE` and `CREATE INDEX` SQL. Name, order, type, nullability, default, primary
key position, index uniqueness/partial flag, foreign-key action, and `CHECK`
text must equal the compiled manifest. Extra application tables or indexes are
also an error. This validation occurs on a read-only descriptor before any WAL,
SHM, pragma, repair, or schema write. `integrity_check` must return only `ok` and
`foreign_key_check` must return no row. A version-3 file with the old
`native_admissions` and `native_attempt_assignments` pair therefore fails
without a migration attempt.

## Native event, claim, and report API

All routes use exact `application/json`, no query, a 64 KiB body and response
cap, two-second client operations, `Cache-Control: no-store`, and no redirect.
The accepted native event is the exact shape in `CI-NATIVE-DELIVERY-001`. The
host claim request is:

```json
{
  "schemaVersion": 1,
  "requestId": "10000000-0000-4000-8000-000000000000",
  "hostId": "host-a",
  "capacity": "primary"
}
```

An available claim returns `200` and the exact claim fields required by that
contract. No work commits an `empty` request receipt and returns `204`; its
internal claim ID is not returned. A repeated request returns the original
`200`, `204`, or terminal denial. It never selects new work. Renewal, result,
and recovery requests repeat the host, capacity,
claim, attempt, and descriptor identities so the service can compare the full
tuple before mutation. Result bodies add only the native terminal event and
`cleanupComplete: true`. Recovery bodies add only the inspected immutable local
resource ID and `cleanupComplete: true`; they cannot report success evidence.

The role matrix is closed:

| Credential | Allowed | Always denied |
| --- | --- | --- |
| native webhook | submit and replay one native review-job event | query, admission, claim, renew, recover, result |
| native query | read exact admission/current-attempt verification | every mutation and inventory listing |
| ordinary native identity | read exact policy and issued-attempt proof | Git, descriptor derivation, native mutation |
| ordinary attempt issuer | derive the strict descriptor and issue or revoke its exact receipt-bound current attempt | report, approve, promote, Git, administration |
| ordinary result reporter | replay exact accepted terminal event | issue, revoke, approve, promote, Git |
| host admission | refresh or revoke canonical operator membership | event, claim, execution result, native evidence |
| host execution | claim, renew, submit cleaned-up result, recover its configured capacity | admission, cross-host/capacity use, native service calls |

Invalid authentication is `401`; valid wrong-role credentials are `403`.
Foreign scoped identities are concealed as `404`. A stale generation, tuple or
state conflict, changed idempotency-key reuse, live fence, or lost lease is
`409`. Capacity limits are `429`. Native dependency, durability, or activation
failure is `503`. Syntax is `400`, exact content type is `415`, and body size is
`413`. Each denial is checked before transaction mutation. In particular, an
authenticated webhook with a valid event ID but any executable field receives
`400`, and no parser drops that field before validation.

### Crash sequence

For claim request `R`, ordinary CI selects demand `D` for `host-a/primary` and
commits preparing receipt `C`. It derives descriptor `X`, then native Git issues
attempt `A` with `issuanceRequestId = C`. Suppose the ordinary process dies
before storing the assignment. On restart, the new service epoch fences every
previously active claim but leaves this preparing receipt owned by `R`. Retrying
`R` resumes `C`, replays issuance ID `C`, receives the same `A`, rereads native
issued-attempt proof, and commits assignment plus active claim atomically. It
does not issue `A2`, return `D` to the queue, or let another host claim `D`.

If the generation changed while the process was down, restart instead revokes
`A`, marks `D` superseded and `C` released, and returns conflict for `R`. If an
active claim had existed, the capacity would stay fenced until that same host
reported ownership-safe cleanup. A foreign same-name container cannot clear the
fence. This is invariant G1.

If native Git loses every webhook acknowledgement, it may replay event `E`
after all seven-day detailed rows for completed attempt `A1` have been pruned.
Ordinary CI first finds permanent `(eventId, eventDigest)` fence `E`. If a
different event ID names the same review/job tuple, it finds the permanent
`(reviewId, jobName, tupleDigest)` fence instead. An exact digest match returns
the original `202` without creating demand `D2`, claim `C2`, or attempt `A2`;
a digest mismatch returns conflict. Fence-table saturation returns `429` only
for unseen input requiring a new fence and never prevents a known replay.

## Admission and execution flow after a Project adapter

This flow is constrained but unavailable. Bundle installation leaves both
services empty and idle. Until a separate native Project/repository state
adapter is specified and implemented, admission, native webhook demand,
capacity advertisement, claim, and result operations fail before mutation.

1. A trusted host controller uses only its admission credential to submit the
   operator-authorized native Project/repository, protected ref, policy and
   review/job-set revisions, and required candidate-controlled job names. The
   source verifies native Git identity and protected policy, and the service
   binds its own central
   `hosts[].capacities[]` set without storing a per-Project assignment list
   before it publishes or refreshes one leased admission generation.
   Admission does not read or trust candidate job bytes.
2. A review binds the exact expected protected head and candidate commit/tree.
   For each required job, native Git reads schema-2 `.dim/ci/runner.yml` and the
   named regular script blob directly from that candidate tree and produces the
   strict normalized descriptor from `CI-NATIVE-CANDIDATE-JOB-001`.
3. Native Git durably creates and retries one authenticated, non-executable
   review-job event. Ordinary CI rereads native identity and policy proof and
   commits the inbox event plus queued demand against the current admission
   before acknowledging delivery. It does not derive a descriptor or issue an
   attempt during webhook handling.
4. A host controller claims through its host credential for one configured
   capacity. Ordinary CI first commits the durable claim receipt, uses its UUID
   as the native issuance request ID, then uses only `attemptIssuer` to derive
   the strict descriptor for the selected capacity and issue or replay the native attempt, verifies native
   proof, then commits assignment and active claim together. The returned claim
   contains the immutable descriptor, attempt, generation, bounds, and lease,
   and no reusable authority.
5. The controller ownership-checks its local capacity; force-pulls the operator
   runner base and candidate job image by digest; fetches the exact candidate
   commit through its existing native read authority; independently verifies
   the commit/tree, config and script blobs, strict parse, and descriptor
   digest; then launches one bounded ephemeral Sysbox runner. The direct argv is
   exactly `[/bin/bash, --noprofile, --norc, /run/dim/job/script]`; no webhook
   string enters a shell, and the host replaces the candidate image's configured
   entrypoint and command with that array. It renews the lease, stops and
   removes its exact owned runtime, then submits terminal evidence with the same
   host-scoped execution credential.
6. Ordinary CI commits the immutable host result and report outbox before
   acknowledging it. The reporter retries the exact terminal event with only
   its native result-reporter credential. Native acknowledgement completes the
   demand and releases the cleaned capacity. Generation rotation, lease loss,
   or service restart instead applies G1 fencing until exact host recovery.

A zero exit is candidate-controlled self-test evidence. It may satisfy the
protected policy's required condition and records successful bounded execution
of the selected tests. It is not independent verification, does not establish
that the tests are correct or complete, and is not blanket proof of product
correctness. Product maintainers still review changed requirements,
implementation, tests, and relevant results for regressions. Infrastructure
security review separately focuses on secret exposure, protected-ref authority,
host/runtime privilege, and trusted capability elevation. Human review of the
complete exact tree and native Git's final CAS remain unchanged.

An unavailable native service, invalid protected tuple, missing admission,
wrong service or host identity, unknown capacity, expired generation, changed
descriptor, config/script mismatch, changed image or runner base, uncertain
lease, or failed result submission fails closed. No condition falls back to a
persistent runner, local scheduler, direct protected write, or unpinned image.

## Updates and recovery

The facade updates `ordinary-ci` first and `native-git` second. Each image is
digest-pinned and each replacement must pass authenticated `/readyz`; ordinary
readiness is local-only, while native readiness additionally proves the exact
ordinary dependency. Candidates reject mutating operations until the installer
publishes and activates their exact immutable generation. The prior Compose
bytes, image digests, and input snapshots remain available through rollback.
Rollback restores those inputs and images in the same order but never rolls
back a data volume.

Before replacement, candidate and prior images must report the same current
state format. For each service, the current persisted state format must be in
both images' `readableFormats`, the candidate `writeFormat` must be in the prior
image's `readableFormats`, and the prior `writeFormat` must be in the candidate
image's `readableFormats`. Missing, disagreeing, one-way, or non-overlapping
compatibility metadata rejects the update before mutation. These three checks
permit both forward startup and rollback after activation without copying or
reverting data.

Schema-less, schema-1, and predecessor schema-2 ordinary databases are rejected
before opening WAL or writing bytes. A missing established volume, changed
deployment ID, service UID, mount path, volume name, or container port is an
operator incident. There is no migration, volume copy, dual-write, or adoption
path. Use the old pinned release to stop legacy services and remove
Project-scoped Sysbox capacity before a fresh schema-3 deployment. No export or
conversion procedure is defined here.

After the separate Project adapter exists, an expired claim fences only that
host capacity. Ordinary-service restart creates a new service epoch and changes
every previous active claim to recovering before accepting another claim on
that capacity. The same host controller inspects and reaps the exact locally
owned container before acknowledging recovery; a foreign same-name resource
remains untouched and keeps the capacity fenced. Other capacities continue.
Restart preserves admission generations, queued demand, receipts, attempts,
claims, results, and report outbox rows, but never converts an old generation to
current. Preparing receipts resume with the same claim/issuance UUID only while
their generation remains current. Native-service restart preserves its event
outbox, issued attempts, and immutable results and therefore accepts exact
delivery, issuance, and report replay.

## Operator acceptance

Acceptance requires the control-plane bundle gate in
`specification/specs/12-verification.md`. The previous
`just verify ordinary-ci-pool-live` Gitea fixture is predecessor evidence only;
it is not acceptance for this native schema-3 topology. The replacement gate
must exercise bundle isolation, local ordinary readiness, native dependency
readiness, credential-role denials, immutable input snapshots, compatibility
refusal, and update rollback. Successful Project admission, two-host execution,
and real Sysbox job evidence remain blocked on the missing native Project
adapter and MUST NOT be claimed by this installer-only gate. QEMU scheduler
checks remain separate Gitea-only predecessor evidence.

Source acceptance for the future emitter, inbox, scheduler, host client, and
reporter is separate from that installer-only gate. It must cover exact event,
claim, renewal, result, and recovery JSON; all role crossovers and status-code
classes; inbox replay and conflicting event-ID reuse; oldest-demand selection;
one claim per capacity; the claim-receipt crash sequence above at every remote
call and transaction boundary; exact reuse of `claimId` as
`issuanceRequestId`; descriptor equality after host reparsing; report retry
across both service restarts; and G1 fencing after expiry, rotation, restart,
foreign residue, and uncertain renewal. Tests must lose every native webhook
acknowledgement, complete `A1`, advance beyond seven days, prune all eligible
detailed rows, replay the same and a new-ID equivalent event, and prove neither
creates `D2`, `C2`, or `A2`. Tests must fill each 100,000-row replay-fence table,
observe `429` only for unseen input without eviction, and prove known exact
replay still returns its original acceptance. Only dependent detailed records
whose replay fences survive may prune.

Database tests must create the final schema from empty state, reopen it, and
then independently alter each table, index, column property, foreign key,
unique constraint, and state check to prove startup rejects before WAL or any
byte change. The unreleased two-table version-3 authority database is a required
rejection fixture. There is no migration-success test.

The source parser, schema-2 state transition, candidate checkout/materializer,
scheduler descriptor binding, and host executor described above are also
unimplemented. Existing schema-1 protected-root runner config and predecessor
ordinary state are rejected by the target rather than migrated or accepted as a
second format.
