# `@slop-lab/dim-native-git`

DIM-owned Git smart-HTTP transport, complete-tree review evidence, exact CI
status evidence, and protected promotion for registered Project repositories.
This package supports clone, fetch, workspace proposal pushes, host-side
inspection and human approval of immutable proposal tuples, authenticated
per-job terminal CI results, and a host promotion API. It is not an issue
tracker, workflow runner, or GitHub Actions-compatible API.

## Security boundary

The service authenticates HTTP Basic identities from a trusted startup
configuration. Every identity is bound to one Project and an explicit set of
repository IDs. A reader may advertise and fetch those repositories. A writer
may additionally create or fast-forward only refs below:

```text
refs/heads/proposals/<workspace-id>/
```

The server-side `pre-receive` policy denies all other refs, proposal deletion,
and non-fast-forward proposal updates. Reviewer and administrator identities
cannot use Git transport. Reviewers may approve only a complete immutable
base-to-candidate review for which policy designates them; administrators may
inspect and revoke but cannot approve. Approval is durable evidence only.
The configured `ordinaryCi.attemptIssuer` credential derives candidate
ordinary-execution descriptors and issues and revokes current job attempts,
but cannot use Git transport or report results. The configured
`ordinaryCi.resultReporter` credential can report only an exact current issued
attempt, and only a dedicated promoter identity can request the checked
promotion transaction. Neither ordinary-CI credential is a native Git identity.
Administrator credentials cannot approve or promote. No Git transport identity
can update a protected ref.

Each review binds the Project and repository, protected and proposal refs,
expected protected head, candidate commit and tree, policy, review, and job-set
revisions, proposal writer, required human reviewers, complete changed-path
metadata, and binary-preserving patch evidence. Changed paths include old and
new modes and object IDs, rename/copy identity, and symbolic-link targets.
Path-prefix rules may add required reviewers based on either side of a rename,
but every approval still covers the entire review object. A moved protected or
proposal ref, changed candidate tree, changed policy, or changed bound identity
makes existing approval stale.

Unknown routes, foreign Projects, foreign repositories, malformed paths, and
unregistered repositories are not passed to Git. Both receive-pack discovery
and receive-pack RPC require an authorized writer. The configured absolute Git
executable must be a trusted regular file, report the exact configured
`gitVersion`, and retain the same filesystem identity for the service lifetime.
Registered repository and hook paths reject symbolic links, and each backend
invocation overrides repository-controlled hook and receive policy settings.
Backend process concurrency, request size, and execution time are bounded.

Terminate TLS in a reviewed reverse proxy or expose the service only on a
private isolated network. Basic credentials must not cross an untrusted
plaintext network.

## Configuration

The executable accepts exactly one absolute JSON configuration path:

```bash
dim-native-git serve /etc/dim/native-git.json
```

The configuration must be a caller-owned, non-symlink, mode-`0600` regular
file because it contains transport credentials.

Example schema-2 configuration:

```json
{
  "schemaVersion": 2,
  "serviceId": "native-main",
  "host": "127.0.0.1",
  "port": 9080,
  "storageRoot": "/var/lib/dim/native-git",
  "gitExecutable": "/usr/bin/git",
  "gitVersion": "2.43.0",
  "ordinaryCi": {
    "endpoint": "http://ordinary-ci:8080",
    "serviceId": "ordinary-main",
    "query": {
      "username": "native-main",
      "password": "replace-with-query-only-dependency-credential"
    },
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
    },
    "webhook": {
      "endpoint": "http://ordinary-ci:8080/v1/native-events",
      "username": "native-events",
      "password": "replace-with-webhook-only-credential"
    }
  },
  "repositories": [{
    "projectId": "project-a",
    "repositoryId": "root",
    "reviewPolicies": [{
      "protectedRef": "refs/heads/main",
      "policyRevision": "policy-1",
      "requiredReviewRevision": "reviews-1",
      "requiredJobSetRevision": "jobs-1",
      "requiredJobNames": ["source", "security"],
      "requiredReviewerIds": ["owner"],
      "pathReviewerRules": [{
        "pathPrefix": ".dim/",
        "reviewerIds": ["lifecycle-owner"]
      }]
    }]
  }],
  "identities": [
    {
      "role": "writer",
      "username": "workspace-a",
      "password": "replace-with-random-secret",
      "projectId": "project-a",
      "repositoryIds": ["root"],
      "workspaceId": "workspace-a"
    },
    {
      "role": "reviewer",
      "username": "owner-reviewer",
      "password": "replace-with-random-secret",
      "projectId": "project-a",
      "repositoryIds": ["root"],
      "reviewerId": "owner"
    },
    {
      "role": "reviewer",
      "username": "lifecycle-reviewer",
      "password": "replace-with-random-secret",
      "projectId": "project-a",
      "repositoryIds": ["root"],
      "reviewerId": "lifecycle-owner"
    },
    {
      "role": "promoter",
      "username": "host-promoter",
      "password": "replace-with-random-secret",
      "projectId": "project-a",
      "repositoryIds": ["root"]
    },
    {
      "role": "administrator",
      "username": "review-admin",
      "password": "replace-with-random-secret",
      "projectId": "project-a",
      "repositoryIds": ["root"]
    }
  ]
}
```

`ordinaryCi.endpoint` and `ordinaryCi.webhook.endpoint` are exactly the private
Compose origin and native-event path shown above. All five ordinary-service
usernames and passwords must be pairwise distinct and must not equal any native
Git identity username or password. Installed readiness uses only `query` to
authenticate exact `GET /v1/native-root-admission/identity`; the response must
attest schema 1, service ID `ordinary-main`, the same serving generation, role
`native-root-admission-reader`, and ordered scope
`imported-root-admission:read`. Legacy attempt-query identity is not a readiness
substitute. This admission reader can query eligibility but cannot issue an
attempt, report a result, promote, or use Git transport.

Native Git identities are limited to reader, writer, reviewer, promoter, and
administrator roles. Schema-2 configuration rejects the obsolete generic
`scheduler` and `ci` identity variants; ordinary protected-promotion evidence
must use `ordinaryCi.attemptIssuer` and `ordinaryCi.resultReporter`.

The webhook credential is outbound-only and is sent only in the Authorization
header. After repository validation, one service-owned dispatcher submits the
oldest undelivered canonical review-job event to the fixed webhook. Review
creation does not wait for ordinary CI: outage, timeout, rejection, malformed
JSON, a wrong event ID, a cacheable response, or a redirect leaves the event
pending and retries the identical bytes with bounded exponential backoff up to
30 seconds. Only exact `202 application/json`, `Cache-Control: no-store`, and
`{schemaVersion:1,eventId,accepted:true}` acknowledgement creates a durable
mode-`0600` `dim-reviews/delivered/<event-id>.json` marker containing the exact
event digest. Startup validates every marker against its immutable envelope;
enumeration excludes only valid markers. Shutdown aborts in-flight delivery and
clears retry waits before releasing storage ownership.

Each repository admits at most 10,000 pending events and reserves at most
100,000 permanent delivery markers. Reviews reserve marker capacity for their
complete required-job event set before publication. Pending events and delivery
markers are never age-pruned; at capacity, exact existing review replay remains
idempotent while a new review fails with `429`.

Verification uses exact `POST /v1/admission-verifications` and
`POST /v1/current-attempt-verifications` requests. Each request carries a fresh
UUID nonce and the complete descriptor admission or current-attempt tuple. A
successful `200 application/json` response must set `Cache-Control: no-store`,
identify the pinned service, authorize the request, and echo the nonce and
entire tuple exactly. Responses are limited to 64 KiB. Redirects, malformed or
extra JSON fields, replayed nonces, non-200 statuses, tuple differences,
timeouts, and transport errors reject. The client performs no retry.

The `ordinaryCi.identity` credential is accepted only by the native Git
ordinary-authority proof API. It is not a native Git identity and cannot use
Git transport, reviews, descriptor derivation, attempt issuance or revocation,
status reporting, promotion, or administration. The service exposes exactly:

- `GET /v1/ordinary-authority/identity`, attesting schema 1, service ID
  `native-main`, role `ordinary-authority-reader`, and ordered scope
  `policy:read`, `review-event:read`, `attempt:read`.
- `POST /v1/projects/<project>/repositories/<repository>/ordinary-authority/policy`,
  accepting only a fresh request UUID and exact protected ref. It returns the
  registered Project/repository/ref, current policy revisions, and sorted
  required job names. It does not accept or return host/capacity eligibility.
- `POST /v1/projects/<project>/repositories/<repository>/ordinary-authority/review-event`,
  accepting only a fresh request UUID plus exact event, review, and job IDs. It
  derives every repository, ref, candidate, and policy field from the immutable
  stored envelope, rechecks the live review under the protected-ref serializer,
  and returns the echoed nonce with the exact canonical non-executable event.
  Missing or selector-mismatched events return `404`; policy or live-ref
  staleness returns `409`.
- `POST /v1/projects/<project>/repositories/<repository>/ordinary-authority/current-attempt`,
  accepting only a fresh request UUID plus exact review, job, and attempt IDs.
  It returns the complete canonical current unrevoked assignment projected from
  the immutable schema-2 attempt record.

All three proof requests require exact JSON, reject query parameters, and cap
both request and successful response bodies at 64 KiB. They return
`Cache-Control: no-store`. Missing, foreign, unissued,
revoked, replaced, stale-review, or current-policy-drifted tuples return no
proof. The review-event request cannot supply an image, script, command,
descriptor, ref, candidate object, policy revision, or administrator selector.
Responses contain no credentials, reviewer rules, patches, or candidate blob
bytes.

Trusted host setup calls `initializeNativeRepository` before starting the
service. Registration derives storage only from validated Project and
repository IDs, creates a bare repository below `storageRoot`, pins receive
policy, and installs the proposal-only hook. Initial import is a separate
trusted host operation and is not exposed over HTTP.

## Review administration

The review CLI calls the authenticated review API. Supply credentials through
the environment so passwords do not appear in command arguments or output:

```bash
export DIM_NATIVE_GIT_USERNAME=owner-reviewer
export DIM_NATIVE_GIT_PASSWORD='replace-with-random-secret'

dim-native-git review http://127.0.0.1:9080 inspect \
  project-a root refs/heads/main \
  refs/heads/proposals/workspace-a/change-1
dim-native-git review http://127.0.0.1:9080 show \
  project-a root REVIEW_ID
dim-native-git review http://127.0.0.1:9080 approve \
  project-a root REVIEW_ID
dim-native-git review http://127.0.0.1:9080 revoke \
  project-a root REVIEW_ID APPROVAL_ID
```

`inspect` and `show` return the exact SHAs, refs, changed paths, modes,
symbolic-link targets, patch, required reviewers, and current status as JSON.
Review objects and approval/revocation events are immutable mode-`0600` records
inside the owned bare repository and are validated when the service restarts.

## CI evidence and promotion

The dedicated `ordinaryCi.attemptIssuer` service credential first issues the current attempt through
`POST .../reviews/<review-id>/job-attempts`; it may revoke that attempt through
`POST .../job-attempt-revocations`. Only `ordinaryCi.resultReporter` submits
CI reports, using the native
`dim.ci.job.completed` schema-2 event envelope. Issuance requires a UUID
`issuanceRequestId`, the expected canonical descriptor digest and all operator
descriptor inputs, plus the assigned `hostId` and `capacity`. Native Git derives
the full descriptor again under the protected-ref serializer, verifies current
ordinary admission, and durably stores the full descriptor and assignment.
Exact current replay returns the same attempt; changed or superseded request-ID
reuse conflicts. The payload repeats the full descriptor, digest, assignment,
server-issued attempt identity, start and finish times, terminal completion,
result, and bounded stdout/stderr byte counts and digests. This is a DIM event
contract, not an emulation of GitHub Actions or another provider API. Records
are immutable, restart-checked, and conflict when the same job attempt is
reported with different evidence.

Only the current, unrevoked issued attempt can be reported or satisfy promotion.
Issuance, report, and promotion each require an injected ordinary-admission
verifier to confirm the exact current generation, descriptor digest, host, and
capacity. The executable uses a rejecting verifier by default; protected CI
mutation therefore fails closed until the authenticated ordinary-service client
is configured. The native attempt binds evidence class `candidate-controlled`
and the exact candidate config/script blobs,
normalized fixed argv, operator job-base and runner-base digests, effective
bounds, host, and capacity. A successful result records that the selected
candidate-controlled tests executed within the recorded sandbox and exited
zero. Protected policy may require that evidence, but it is not independent
verification, does not establish that the tests are correct or complete, and
does not replace product/QA review or complete-tree human approval. This
package exports `loadCandidateOrdinaryExecution` as the narrow candidate-tree
reader for that future adapter. It accepts a registered native Git configuration
and the exact review/admission tuple, reads only `.dim/ci/runner.yml` and its
selected script from the named candidate tree, and returns the normalized
descriptor and digest. It does not schedule or launch work.

The package also exports `parseNativeCandidateJobConfig` as a parse-only boundary
for the target schema-4 candidate file. It accepts raw bytes plus a trusted
kind-labelled required-job policy, rejects overlapping ordinary/QEMU names and
any mismatch with those separate policy sets, and returns canonical ordinary and
QEMU job maps plus a deterministic kind-labelled plan. It does not read candidate
trees or scripts, admit or schedule work, execute Sysbox or QEMU jobs, report
results, or alter the active schema-3 ordinary path.

The separate `loadNativeCandidateJobInputs` library API pins one registered
Project repository and protected ref, requires the caller's required job names
to equal that registered policy's flat required-name set, and pins the protected
head, candidate commit, and candidate tree; reads
the schema-4 config and every ordinary/QEMU script as bounded regular blobs from
that exact tree; then rechecks the protected head after all reads. It supports
both SHA-1 and SHA-256 repositories and returns only config/script object IDs,
SHA-256 digests, safe paths, execution-kind labels, job names, and the fixed
argv. It returns no executable bytes, images, bounds, host or capacity choices,
credentials, admission, attempt, result, scheduling, or VM authority.

The standalone registered review policy still constrains names rather than
execution kinds, so direct loader callers remain responsible for supplying a
reviewed kind-labelled set. The distinct internal
`loadAuthoritativeNativeCandidateJobInputs` entrypoint instead accepts the
trusted activated bundle runtime plus only a Project and candidate commit/tree.
It derives the owner host from registered state and the protected ref, expected
head, and sorted kind-labelled required jobs from the exact live durable
`authoritative-v1` imported-root policy. It performs full owner, bundle, ref,
commit, tree, and reachable-graph verification before and after bounded Git
reads, including exact current serving-generation activation. A completed
`legacy-import-only` row remains available to import proof and protected-root
read paths but cannot authorize this reader. The entrypoint returns the same
identity-only plan and has no HTTP route, admission, scheduling, execution,
review, result, or state-mutation authority.

Before issuing an attempt, the attempt issuer obtains that descriptor through exact
`POST /v1/projects/<project>/repositories/<repository>/reviews/<review-id>/ordinary-execution-descriptors`.
The request has no query parameters, is bounded to 64 KiB, requires exact
`application/json`, and accepts only:

```json
{
  "jobName": "source",
  "admissionGeneration": "generation-7",
  "jobBaseImage": "registry.example/job@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  "runnerBaseImage": "registry.example/runner@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "bounds": {
    "cpu": "2",
    "memoryBytes": "2147483648",
    "pids": "512",
    "wallClockSeconds": "900",
    "outputBytes": "10485760"
  }
}
```

Unknown fields and noncanonical values are rejected. The service derives the
Project, repository, protected ref, expected head, candidate commit and tree,
and policy revisions from the named immutable review. It returns only
`{reviewId, descriptor, digest}` and creates no attempt, result, or other state.
Pending, approved, and revoked current reviews may produce descriptors so CI
can inform review; stale reviews and invalid candidate execution trees return
conflict. The service checks review status both before and after its bounded
local Git object reads, closing proposal fast-forward races that bypass the
in-process ref serializer. Exact replay with unchanged review and operator
inputs returns the same descriptor and digest.

The reader represents config and script SHA-256 fields as
`sha256:<64 lowercase hexadecimal digits>`. Its CPU, memory-byte, PID,
wall-clock-second, and output-byte bounds are positive canonical decimal
strings. The descriptor hash starts with the unframed ASCII domain
`dim-native-ordinary-execution-v1`; each of the 28 following fields is encoded
as its ASCII decimal UTF-8 byte length, one colon, and its UTF-8 bytes. These
choices are part of the exported library contract so scheduler and host
reverification cannot choose different normalized encodings.
Attempt, revocation, status-envelope, and status-record state accepts only
schema version 2. Existing version-1 CI evidence is rejected at startup without
rewriting it; reviews and human approvals remain immutable and unaffected.
The service holds an exclusive rollback-journal SQLite transaction in
`.dim-native-git-owner.sqlite3` below the canonical storage root. The database
is bound to that root's filesystem identity, and a second process sharing the
volume fails before repository validation or TCP listen even when it runs in a
different network namespace. The kernel releases the transaction after a
crash, so a replacement process can recover without PID liveness checks or
stale-owner cleanup. Startup rejects symbolic-link or malformed owner state and
storage on filesystems outside the supported local Linux filesystem allowlist.

`POST .../reviews/<review-id>/promotions` is accepted only for the dedicated
promoter identity. Under the per-repository/ref serializer it rereads policy,
refs, approvals, and the current issued attempt for every required job;
requires current verifier admission, exact exited-zero terminal evidence and
descriptor/assignment identity, and descendant ancestry; then uses
one Git ref transaction to verify the proposal candidate and update exactly the
expected protected object ID to the reviewed candidate. Mismatch leaves the
protected ref unchanged. Repeating the request returns `already-current` only
when that exact reviewed candidate is current and the remaining tuple evidence
is still valid.

## Current integration status

This package is additive and is not selected by `@slop-lab/dim-core` yet.
Existing managed and external Gitea lifecycle behavior remains unchanged. This
package's installed native Git image uses strict format-8 state and a strict
schema-7 operator config with distinct host-bound Project registrars, root
importers, root read issuers, workspace write issuers, and global human
reviewer credentials. Each human reviewer has a unique reviewer ID and
canonical 32-byte credential; there is no static Project grant in config.
Empty role lists retain the idle service only
for empty Project state. With a registrar configured, the activated service
prepares one owned, inaccessible root per Project after exact generation
activation. A different authenticated importer can then submit one bounded,
self-contained Git bundle and a strict schema-1 imported-root policy. That
policy stores sorted `{name, kind, evidenceClass: "candidate-controlled"}` jobs,
uses v2 policy/job revision domains, retains the v1 reviewer revision domain,
and is hashed and retained in the format-8 import row's `policy_json`. Fresh flat-name policies
are rejected before state mutation. Completed flat-policy rows from the earlier
unreleased implementation remain live-proof/read-only data; incomplete rows
cannot resume or roll generations. The read issuer can
request a live-proof-bound root-read lease only for an imported Project owned
by its configured host. Exact
`POST /v1/projects/<project>/root-read-leases` accepts only schema version 1 and
the active generation. It returns a service-selected 30-second random Basic
credential scoped to that Project's fixed `root` repository. The issuer
credential is not itself accepted by Git. Lease digests and scope exist only in
memory, so expiry and service restart invalidate the credential without durable
cleanup. The service retains at most 16 unexpired leases, prunes expired entries
before issuance and authentication, and bounds lease issuance plus transport to
16 concurrent operations. A separate owner-host workspace write issuer can
request an equally short-lived lease for `root` and one canonical 43-character
base64url workspace ID only after live authoritative imported-policy proof.
That credential can fetch and can create or fast-forward only its own
`refs/heads/proposals/<workspace-id>/...` refs. The service rechecks the Git
executable identity and exact installed hook before every backend; protected
refs, tags, foreign workspace namespaces, deletion, and non-fast-forward writes
remain denied. Read and write use the same 16-operation gate and both lease
registries are memory-only. The service durably binds the import digest and the
expected commit, verifies the complete object graph with image-pinned Git
`2.39.5`, and uses a separate exact finalize request to install only objects
before an unborn-ref compare-and-swap creates the initial protected head.
File and directory syncs precede the durable import completion record; restart
rechecks and resumes only the bound import. Foreign storage, changed intent,
or a preexisting protected ref is not adopted. Obsolete format-5 and format-6
draft state is rejected unchanged.

The host-side core package exports a distinct mode-`0600` root importer
connection and a bounded streaming client.
`GET /v1/operator-root-importer-identity` attests the importer role, owner host,
service, and exact generation without mutating the database, including before
activation. The client verifies that identity immediately before both upload
and finalize, then binds the service receipts to the source commit, protected
ref, bundle digest and size. This does not make the Project runnable.

The importer-only `GET /v1/projects/<project>/root-import/proof` returns a
strict schema-3 envelope containing the current serving generation, the original
import receipt, and a separate verified current head only
while the durable activation token, Project owner
marker, private bare repository path, retained bundle, sole protected ref,
original commit and tree, and full reachable graph still agree. Sequence zero
exactly identifies the import. Format-8 defines a future promotion ledger, but
the installed service currently rejects any nonempty intent or finalized ledger
at startup and during proof: self-declared hashes cannot stand in for separately
verified human approval and ordinary/QEMU evidence. Unrecorded ref drift yields
no proof. A completed legacy-policy import remains
sequence-zero read-only data and cannot authorize promotion. The endpoint neither installs
objects nor writes refs or service state. A host compares this read-only proof
with its durable non-runnable draft's byte-identical nested receipt before
persisting a final receipt or returning an already-imported draft. The host
strictly parses the separate current head but never rewrites the original draft.
Missing or stale proof never grants Git
transport, review, CI, or Project readiness. The same full live check runs
again before every lease-backed upload-pack discovery and RPC. A moved or
foreign ref, changed durable bundle, missing owner marker, incomplete object
graph, wrong Project or repository, expired lease, generation mismatch, or
restart denies access. Receive-pack is always denied for these leases and
disabled in the backend for non-writers. Transport re-authenticates after live
verification before spawning Git. Shutdown first stops lease/read admission and
invalidates leases, then drains admitted verification and backend work before
releasing storage ownership.

Root import does not publish a runnable DIM Project or issue a durable Git
reader, workspace writer, reviewer, or promoter credential. The installed
bundle exposes the short-lived, owner-host-issued protected-root upload-pack
lease above plus a distinct 30-second workspace-write lease after live
authoritative imported-policy proof. That write lease permits only creation or
fast-forward of its exact workspace proposal namespace through the checked
pre-receive hook; it has no protected-ref, tag, deletion, force-rewrite, reviewer,
CI, promotion, or Project-ready authority and is
not connected to runnable core Project lifecycle, ordinary Sysbox CI, or QEMU CI.
The host-only draft reader consumes the root-read lease after matching the original
receipt and current serving proof, but its presence does not make a Project
ready or selectable. The installed bundle object exposes an in-process
`createReview` method only to its trusted caller. It accepts the Project,
literal `root` repository, and one canonical workspace proposal ref; derives
the live authoritative policy, protected head, candidate commit/tree, and
workspace namespace; and stores one immutable complete-tree review with a
sorted kind-aware `candidate-controlled` event set. It repeats the imported-root
and ref proof after reading the complete binary-preserving diff. Review state is
strictly checked on restart. Schema 7 additionally exposes exact
`GET /v1/human-reviewer-identity` and
`GET /v1/projects/<project>/repositories/root/reviews/<review-id>`, plus a
reviewer-only exact `POST` to that review's `/approvals` or `/revocations`
suffix. The GET
requires the identity-attested serving generation in `x-dim-generation-id` and
returns the immutable envelope, approvals, and `pending`, `approved`, or
`stale` status after fresh
import, policy, protected-head, proposal-commit, and proposal-tree checks. Scope
is derived from the stored review's required reviewer IDs; unknown Projects and
review IDs are concealed, other known roles and unrequired reviewers are
denied, and proof outage is unavailable. Proposal, head, or policy drift leaves
the historical review readable as stale. The POST accepts only a UUID
`requestId`, derives every other field, requires the review to be current, and
reconstructs the complete review identity from current policy and pinned Git
evidence, including path-added reviewers, and publishes one domain-digested
mode-`0600` single-link immutable approval without replacement.
Exact retry converges across restart; a conflicting active request is refused.
The response includes freshly rechecked status and stale reasons after publication;
an old-tuple approval does not assert current approval after ref drift.
Revocation accepts only one 64-hex approval ID, derives the reviewer from the
credential, and allows only that reviewer to revoke their exact historical
approval even when the proposal is stale. It publishes a separately
domain-digested immutable record binding review, reviewer, and approval. Exact
replay converges; reapproval requires a new request UUID, and a delayed
revocation of approval A cannot affect later approval B. Startup validates
approval and revocation bytes, paths, ownership, mode, link count, cross-links,
and active uniqueness against the immutable review. `stale` dominates the
otherwise `pending`, `approved`, or `revoked` decision status. No endpoint
lists reviews, returns credentials, moves a ref, writes promotion state, or
grants administrator revocation, CI, promotion, or Project-ready authority. The separate
standalone native Git server retains human approval,
exact CI evidence, and the serialized compare-and-swap transaction required by
`TRUST-PROMOTION-001` and `TRUST-PROMOTION-CAS-001`. Protected-write authority
exists only inside that checked host operation; smart HTTP remains
proposal-only and has no administrator bypass. Core lifecycle wiring, a
host-side workspace-write lease client, reviewer UI, and independent-host CI
gates remain separate work.
Independent CI, when a Project requires it, must use a separately selected
command definition and evidence class; native ordinary candidate self-tests do
not acquire that label by running on another host.

The internal authoritative candidate reader, review creator, and bounded human
decision boundary do not make
imported Projects runnable and provide no ordinary or QEMU scheduler, proposal
writer, result, promotion, or Project-ready authority.

The installed bundle now also exposes trusted in-process, read-only
`deriveOrdinaryExecutionDescriptor` and `deriveQemuExecutionDescriptor` methods
as adapter prerequisites. Their strict inputs name only a Project, immutable
review, required job, and an explicitly operator-trusted capacity containing
the admission generation, digest-pinned job/runner images, and bounds. Each
reconstructs current review identity before and after the bounded schema-4
candidate reads and requires matching policy/review and candidate-plan kinds.
The QEMU result is a separate strict schema-1 descriptor with
`executionKind: "qemu"` and the `dim-native-qemu-execution-v1` digest domain;
ordinary evidence cannot satisfy it. These methods have no HTTP route or
credential and perform no admission, scheduling, attempt, result, execution,
VM launch, promotion, ref, review, or Project-readiness mutation.

The schema-7 installed bundle also exposes a separate read-only
`native-root-ci-proof` HTTP namespace only to `ordinaryCi.identity`. Its
identity route attests role `native-root-ci-proof-reader`, the ordered imported
policy and ordinary-event scopes, and the serving generation even before
activation; this is compatibility identity, not readiness. Its Project/root
policy route returns the complete canonical `authoritative-v1` policy, including
kind-labelled QEMU and ordinary-Sysbox jobs and all reviewer rules, plus the
live import nonce and current root. Its review-event route accepts QEMU as a
valid selector shape but proves only an exact stored current
`ordinary-sysbox` schema-2 event. Both proofs run under the shared review
serializer, repeat authoritative root and review checks, and leave database,
refs, reviews, approvals, and revocations unchanged. Current pending, approved,
and self-revoked reviews are eligible; the proof never means approved. The
namespace has no fallback to the standalone `ordinary-authority` API and grants
no admission, intake, attempt, result, execution, promotion, or ready authority.

The paired installed ordinary service uses this proof to store native-root
eligibility and inert proof-bound event receipts in strict format 5. Registration binds the complete
kind-labelled policy and import identity to the exact installer generation and
global capacity digest; current queries perform no upstream refresh. Exact
request replay survives restart, while expiry, revocation, import/policy
change, generation rotation, or capacity rotation requires a new admission
generation. The installed schema-7 webhook endpoint is
`/v1/native-root-ci-events`. The installed native Git service now delivers
only authoritative ordinary-Sysbox review events automatically after the
query-only admission resolver confirms the current Project/root policy and
generation. The webhook-role dispatcher retains no query credential, retries
the identical event after lost acknowledgements or transient marker writes,
and publishes a private digest-bound marker only after the exact durable
ordinary receipt. Foreign or unsafe markers fail startup unchanged; fatal
delivery integrity errors make readiness unavailable. QEMU events are never
submitted to this endpoint. A receipt is historical delivery evidence only
and does not connect the legacy ordinary
authority, claim, result, execution, or promotion paths.
Every current-validity check must use a fresh UUIDv4 `requestId`. Exact replay
of any operation, including `current`, is a historical receipt and may return
its original success after revocation or expiry; it does not attest present
eligibility.
