# Native Git Transport and Review Evidence

**Kind: Implementation profile**

## Scope

`@slop-lab/dim-native-git` is DIM-owned Git smart-HTTP transport plus durable
complete-tree human-review and exact CI evidence with checked protected
promotion. It supplies registered repository storage, authenticated read
transport, workspace-scoped proposal pushes, immutable review objects,
approval/revocation, per-job terminal status records, and one host-only
serialized compare-and-swap operation. It does not implement issues, pull
requests, workflow execution, general merge administration, or provider
Actions compatibility.

The package is additive and not yet selected by core Project lifecycle code.
Managed and external Gitea remain the current lifecycle implementation while
the native path is independently reviewed and completed.

The installed control-plane bundle runs the service as the `native-git`
member defined by `INSTALLER-CONTROL-PLANE-001`. It runs as `10001:10001`,
listens at `0.0.0.0:8080`, stores all repository and evidence bytes below
`/var/lib/dim-native-git`, and receives only that service's private volume and
read-only config, readiness-token, and activation-token files. Its strict
schema-7 startup configuration pins `serviceId` to `native-main`, requires
`projectRegistrars`, `projectRootImporters`, `projectRootReadIssuers`, and
`workspaceWriteIssuers`, and `humanReviewers`
arrays (all empty for the idle mode), and adds exactly this required dependency
object:

```json
{
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
  }
}
```

The dependency endpoint and webhook endpoint are fixed to the Compose-network
origin and path, follow no redirect, and
must attest the exact service identity before native Git reports ready. The
query credential is scoped only to admission and current-attempt/result queries
for the repository tuple being evaluated. It cannot admit policy, claim
capacity, report a result, enumerate hosts, or mutate scheduler state. It is
distinct from every Git, reviewer, administrator, promoter, scheduler,
CI-result, readiness, webhook, and host credential.

The ordinary identity credential can attest only the exact configured native
service and read the exact registered repository/protected-policy or current
issued-attempt tuple. It receives no Git, review, candidate-blob, mutation,
host-inventory, or per-Project capacity authority. The attempt-issuer credential
is the narrow native scheduler role constrained to derive one descriptor and
issue or revoke one current attempt for an exact live ordinary admission
generation, repository/protected tuple, required job, receipt, host, and
capacity. It cannot report, read Git, approve, promote, or administer. The
result-reporter credential is a separate native CI role that
can report only the terminal result for that exact issuer-created current
attempt and job; it cannot issue or revoke. Neither role can read Git, approve,
promote, administer, enumerate unrelated Projects, or act when the ordinary
admission or native identity check is absent, stale, or mismatched.

These credentials and endpoints do not select native Git for Project lifecycle.
The installed schema-7 bundle may accept exact
`POST /v1/operator-project-preparations` only from an authenticated
host-bound Project registrar after generation activation. It derives the
owner host from that credential, prepares one empty owned root, and responds
with `root-prepared`, not Project admission. A distinct host-bound importer
may upload and finalize the initial protected head as specified below;
neither path issues Git transport or workspace authority. Ordinary admission,
attempt, and result mutation remain unavailable in this bundle. The obsolete
combined writer-registration path is not accepted, and marked format-5 and
format-6 draft state is rejected unchanged.
The separately configured host-bound root read issuer is distinct from every
registrar, importer, service, host, readiness, and activation credential. It is
not a Git identity and its credential cannot authenticate smart HTTP. After
exact activation and a successful live imported-root verification, only that
Project's owner-host issuer may call exact
`POST /v1/projects/{projectId}/root-read-leases` without a query string. The
strict JSON body contains only `schemaVersion: 1` and the exact active
`generationId`. The non-cacheable `201` response contains only schema and
service identity, the Project and fixed `root` repository, generation, a newly
random transport username and password, and an absolute millisecond
`expiresAt` set 30 seconds by the service. The issuer credential is never
copied into or accepted as the transport credential.

Lease authority exists only in the issuing process. The service retains only
digests of the random transport username and password plus the owner host,
Project, fixed repository, generation, and expiry. It writes no lease to
durable state, so process restart invalidates every lease. Expiry is
server-selected and cannot be extended by a caller. At most 16 unexpired leases
may be live; issuance first removes every expired record and fails with `503`
when the remaining set is full. Unknown credentials return `401`, another
known role returns `403`, a foreign or unknown Project returns `404`, a
generation conflict returns `409`, and an inactive service returns `503`.
Issuance returns no lease for an incomplete or non-live import.
The separately configured host-bound workspace write issuer is distinct from
every registrar, importer, read issuer, service, host, readiness, and activation
credential. It is not a Git identity and cannot authenticate smart HTTP.
After exact activation, only the imported Project's owner-host issuer may call
exact `POST /v1/projects/{projectId}/workspace-write-leases` without a query
string. The strict JSON body contains exactly `schemaVersion: 1`, the active
`generationId`, `repositoryId: root`, and a canonical 43-character base64url
workspace ID encoding exactly 32 bytes. Issuance performs one live proof of the
owner-bound imported root and requires its stored policy to be
`authoritative-v1`; a completed legacy import cannot authorize workspace writes.

The non-cacheable `201` response identifies that exact Project, root repository,
generation, and workspace and returns a service-selected random Basic transport
credential expiring after 30 seconds. Only credential digests and scope are held
in process memory. Expiry and restart invalidate the lease, and no issuer or
lease secret enters durable Project, repository, workspace, review, or CI state.
At most 16 unexpired write leases exist. Read issuance, write issuance, live
verification, and Git backends share one 16-operation gate; shutdown synchronously
stops both admissions, clears both lease registries, drains admitted proofs and
backends, and only then releases storage ownership.

Before each upload-pack or receive-pack discovery or RPC, the service performs
one fresh active-generation, owner, imported-policy, durable bundle, protected
ref, commit, tree, and complete-graph proof, then re-authenticates the lease.
It also rechecks the configured Git executable identity and the exact installed
proposal-only pre-receive hook before spawning `git http-backend`. The writer
environment binds the exact workspace ID. Receive-pack can therefore create or
fast-forward only `refs/heads/proposals/{workspaceId}/...`; protected refs,
tags, another workspace namespace, deletion, and non-fast-forward updates fail.
No reviewer, promoter, administrator, CI, Project-ready, or runnable-workspace
authority follows from issuance or transport.

The `humanReviewers` array contains only strict
`{reviewerId, username, password}` entries. Reviewer IDs are globally unique;
passwords are canonical base64url encodings of exactly 32 bytes; and every ID,
username, and password is distinct from every other configured role, service,
host, readiness, and activation credential value. The config grants no Project
or repository scope. Fresh imported policy is accepted only when the union of
its baseline and path-rule reviewer IDs has configured human credentials, and
startup applies the same check to every persisted authoritative policy before
listening.

Exact `GET /v1/human-reviewer-identity` authenticates one reviewer and returns
only schema and service identity, role `human-reviewer`, reviewer ID, and the
serving generation. Exact `GET
/v1/projects/{projectId}/repositories/root/reviews/{reviewId}` requires that
generation in `x-dim-generation-id`, loads only the named immutable review, and
authorizes only a reviewer required by that stored review. It repeats live
imported-root proof and checks the current policy, protected head, proposal
commit, and proposal tree before reporting `pending`, `approved`, or `revoked`;
`approved` requires one active immutable approval from every reviewer required
by the review. A review with a revocation and an incomplete active reviewer set
is `revoked`; a never-approved incomplete review is `pending`. Ref, head, or
policy drift dominates those decision states and returns the unchanged
historical review, approvals, and revocations as `stale`, without creating
current authority. Unknown credentials return `401`, known
other roles and unrequired reviewers return `403`, foreign or unknown exact
paths return `404`, generation conflict returns `409`, and inactive or
unprovable live state returns `503`. Query strings, collection paths, alternate
repository IDs, and other action suffixes are `404`.

Only exact `POST
/v1/projects/{projectId}/repositories/root/reviews/{reviewId}/approvals` adds a
decision. It accepts exact `application/json` containing only a UUID
`requestId`; Project, root repository, generation, policy, review, protected
head, candidate commit/tree, and the reviewer ID are derived from authenticated
and authoritative state. The credential must name a reviewer required by that
immutable review. Currentness is checked by reconstructing its complete identity
from pinned Git diff evidence and current policy, including path-added reviewers,
not merely comparing stored hashes and refs. The operation shares shutdown admission and the review-creation
serializer. Its approval ID is a domain-separated SHA-256 identity over review
ID, reviewer ID, and request ID. One separately domain-digested schema-1 record
is published mode `0600` without replacement and with file and directory fsync
under the service-owned repository. Exact replay returns the same immutable
approval after restart with freshly computed status; another active request
for the same reviewer and review conflicts.
Startup validates every approval's schema, digests, path, ownership, mode,
single-link metadata, required-reviewer relationship, and active uniqueness
against the immutable review. It applies the same bounded ownership, mode,
single-link, path, and digest validation to revocations; rejects orphaned or
cross-linked revocations; and requires each revocation's review ID and reviewer
ID to match its exact immutable approval.

An exact `POST` to the same review's `/revocations` suffix accepts only
`{approvalId: <64-lowercase-hex>}`. The reviewer ID is derived solely from the
authenticated credential. The named approval must belong to that reviewer and
review; there is no administrator override, writer/importer/CI authority, or
foreign/unrequired-reviewer authority. Revocation requires the active owned
Project/root proof and exact serving generation but does not require the
historical review tuple to remain fresh. It shares the review serializer,
shutdown admission, drain, request bound, and non-cacheable response behavior
with approval. The service publishes one schema-1 mode-`0600` no-replace/fsync
record whose separately domain-separated ID and record digest bind the review,
reviewer, and exact approval IDs. Exact replay converges. Reapproval requires a
new request UUID and creates a new approval ID; replaying the revoked approval's
old request returns that revoked evidence and never reactivates it. A delayed
revocation replay for approval A cannot revoke later approval B.

A proposal move after the final proof can leave only approval evidence for the
now-stale old tuple; it cannot make the current review approved. The response
rechecks the tuple after publication and includes `status` and `staleReasons`;
it does not assert current approval after observed ref drift. The operation
does not rewrite review or event bytes, move any ref, write the format-8
promotion ledger, admit CI, promote, or grant Project readiness. Revocation
does not delete or replace approval evidence and grants no promotion authority.
Responses are non-cacheable and expose no configured username, password, other
account, or review list.

The installed bundle has separate trusted in-process read-only ordinary and
QEMU descriptor methods. Each accepts a strict object containing only `projectId`,
`reviewId`, `jobName`, and `trustedCapacity`. The capacity is explicitly
operator-owned and contains only the admission generation, digest-pinned job
and runner images, and canonical positive-decimal CPU, memory, PID, wall-clock,
and output bounds. Project and review selectors cannot supply a ref, candidate
object ID, policy revision, script, argv, image, bound, execution kind, or other
override.

Each method loads the exact immutable stored review, proves its complete current
identity with the same policy, protected-head, proposal commit/tree, and
required-reviewer reconstruction used by the human-review boundary, and does so
both before and after candidate Git reads. It derives the full current
kind-labelled required-job set from the durable imported policy and parses the
candidate's complete schema-4 ordinary/QEMU config through the authoritative
candidate reader. Ordinary selection succeeds only when both review policy and candidate
plan label the named job `ordinary-sysbox`; a QEMU job cannot be aliased through
that API. The response is explicitly kind `ordinary-sysbox` and binds the
review, current protected head, all policy revisions, exact config/script object
IDs and digests, fixed argv, operator images, bounds, and admission generation
under `dim-native-ordinary-execution-v1`.

QEMU selection independently requires both labels to be `qemu` and returns a
separate strict schema-1 descriptor with `executionKind: qemu` and the same
exact provenance projection under `dim-native-qemu-execution-v1`. Its fixed
schema and separate typed digest do not accept an ordinary descriptor as QEMU
evidence. Neither method accepts a caller-supplied execution kind.

Neither method is an HTTP route or consumes a CI credential. They read no
general candidate bytes and create no admission, attempt, result, execution,
review decision, ref update, promotion evidence, or Project readiness. They are
internal prerequisites for future installed ordinary and QEMU authority adapters only.
The five service credentials are not Git transport identities and are not
accepted by generic reviewer, administrator, CI, scheduler, or promotion
routes; each is accepted only by its fixed role-specific endpoint.

The webhook credential is outbound-only. Native Git uses it only to submit the
exact durable review-job event in `CI-NATIVE-DELIVERY-001`. Ordinary CI cannot
use it against native Git, and possession grants no review, descriptor,
attempt, result, Git, or promotion authority. The webhook never carries an
executable selector.

### Initial root bundle import (installed service; host adapter pending)

`PROJECT-NATIVE-IMPORT-001` uses a separately configured, generation-snapshotted
bootstrap credential. It cannot be a Project registrar, Git reader/writer,
reviewer, promoter, readiness/activation token, or ordinary-CI credential.
Only the authenticated bootstrap role may call exact
`POST /v1/projects/{projectId}/root-import` for its owned, `root-prepared`
Project. The service derives its host from the credential, never from the body.
The future trusted host adapter must construct the self-contained Git bundle
from the selected bootstrap ref and normalize policy from `.dim/repos.yml` or
explicit manifest-free protection input. The installed service validates and
binds the submitted policy to the exact requested commit; it does not parse
the imported manifest, fetch a client URL, or accept the caller's Git credentials.

The `application/octet-stream` import request has a strict newline-terminated
JSON prelude of at most 64 KiB followed by raw bundle bytes. Its exact framing
binds schema, active generation, service and Project/root IDs, protected ref,
expected commit, and policy. A known exact
`Content-Length`, a 256 MiB total limit, and the service request deadline are
mandatory; missing, extra, truncated, or ambiguous framing fails closed. Only
one advertised ref equal to the requested protected ref and commit is valid;
tags, prerequisite bundles, symbolic `HEAD`, unrelated refs, non-commit targets,
or incomplete/corrupt object graphs are rejected by the pinned Git executable
in private staging before canonical object installation.

The service records one immutable import intent with its own nonce and policy
digest. It fsyncs and atomically publishes the bounded bundle before advancing
the intent to `bundle-durable`, returning its exact hash and size without
creating a Git ref. The same authenticated importer may send exact
upload bytes again after `root-imported`: the service rechecks the identical
nonce, policy, bundle digest and size and returns the actual `root-imported`
phase without rolling state back or rewriting the protected ref. The client
then repeats the exact finalize request to obtain the complete tree-bound
receipt; changed intent or bundle bytes remain conflicts. The importer sends
`POST /v1/projects/{projectId}/root-import/finalize` with schema version,
generation, import nonce, and bundle digest. The service rechecks the stored
bundle and complete private Git object graph under the pinned executable before
recording `installing`. It installs objects without refs into the owned root,
verifies and syncs the pack/index and resolved commit/tree, then records
`objects-installed`. Only a service-internal all-zero-old-object `update-ref`
CAS may create the initially unborn protected head; the ref and its parent
directories are synced before the final durable `root-imported` transition.
No Project readiness or workspace credential is issued by either operation.

For every fresh import, `policy` is a strict schema-1 object containing the
protected ref, policy/reviewer/job-set revisions, reviewers and path rules, and
sorted `requiredJobs`. Each job contains exactly `name`, `kind` (`ordinary-sysbox`
or `qemu`), and `evidenceClass: candidate-controlled`. The policy and job-set
revisions use `dim-native-policy-v2\0` and `dim-native-jobs-v2\0`; the reviewer
revision retains `dim-native-reviewers-v1\0`. Native Git canonicalizes and
validates those revisions before mutation, stores the complete policy JSON in
the format-8 import row's `policy_json`, and hashes those exact canonical bytes for
the receipt. A fresh flat `requiredJobNames` policy is invalid. A completed
import row containing the earlier flat policy remains proof/read-only and
cannot be replayed as new kind authority; an incomplete flat row refuses
startup/recovery without migration or rewrite.
After `root-imported`, the same authenticated importer may call exact
`GET /v1/projects/{projectId}/root-import/proof` without a query string. A
successful response is `200 application/json` with `Cache-Control: no-store`
and contains only `schemaVersion: 3`, `servingGenerationId`, `ownerHostId`,
`importReceipt`, and `currentHead`. The nested receipt contains exactly the original
schema-1 `serviceId`, `projectId`, `rootRepositoryId`, `generationId`,
`importNonce`, `protectedRef`, `expectedCommit`, `resolvedTree`,
`policyDigest`, `bundleDigest`, `bundleSize`, and `phase: root-imported`.
The receipt generation is immutable import provenance; the serving generation
is the currently activated process and may differ after a bundle update. The
separate current head contains exactly `projectId`, the nonnegative finalized
promotion `sequence`, `protectedRef`, `commit`, `tree`, and `policyDigest`.
Sequence zero is exactly the imported commit and tree. A future later sequence
would require a contiguous finalized format-8 transition for the same import
nonce and policy plus independent review, approval, and kind-bound CI evidence;
the installed service currently refuses every nonempty intent or finalized
ledger at startup and during proof. A self-consistent row or moved ref alone
never establishes promotion authority.
The service returns
that proof only when the process's active generation still matches its durable
activation-token digest before and after inspection, and the host-owned
registration, exact Project owner marker, private non-symlink repository path,
canonical persisted policy and bundle bindings, durable owned bundle bytes,
canonical finalized transition evidence, absence of an unresolved intent, sole live
protected ref at the folded current commit, current tree, imported ancestry, and
complete reachable object graph
all still match. Git inspection pins the configured executable identity and
disables replacement refs and optional locks. Database, bundle, ref, and object
inspection is read-only: this endpoint does not finalize or resume an import,
sync storage, update a ref, or issue any Git, review, CI, or promotion authority.
Unknown credentials return `401`, authenticated non-importer roles return
`403`, and unknown or foreign Projects return `404`. An inactive service
returns `503` for the exact request. Query-bearing and alternate-method forms
return `404`, including while inactive. An incomplete import, changed durable
bundle, unrecorded or foreign ref, wrong current tree, non-descendant head,
unresolved promotion intent, incomplete graph, or changed persisted binding
returns no proof. A completed legacy-policy import can produce only its
sequence-zero proof and cannot authorize promotion, review, or candidate reads.
The host importer parses the exact bounded proof, requires the serving
generation to match its current connection, and compares the owner and every
nested original receipt field with the durable non-runnable draft before storing
or returning an imported result. It parses the current head strictly and requires
its Project, ref, policy digest, object format, and sequence-zero identity to
agree with the receipt, but it never rewrites that receipt or the host draft.
A stale, foreign, missing, or malformed proof
leaves the draft unchanged; proof is not Project readiness.
The trusted host root-read operation first loads the separate owner-only
importer and issuer connections and rejects a different endpoint, owner host,
generation, or overlapping username or password before either client sends a
request. It reads only an exact retained `root-imported` draft and bundle,
requires its owner, service, current serving generation, Project, and complete
immutable original import receipt to match a fresh importer-authenticated proof,
and only then requests the
Project/root lease. After minting, it rereads and compares the complete draft;
changed host state withholds the lease. It returns only the ephemeral lease and
persists neither role credential nor lease. It does not mutate the draft,
Gitea Project state, or native Project readiness.
When a candidate service starts with a completed import from an earlier
generation, it verifies that owned root read-only and denies business requests
until its own generation and token are activated. It does not rewrite the
import row, bundle, protected ref, or host draft. An earlier-generation
incomplete import rejects startup before mutating reconciliation.
Before canonical installation, safe exact-owned incomplete uploads may be
discarded. Once installation begins, startup resumes only the identical
hash-bound bundle and policy; an already-written head is accepted only in the
post-CAS recovery phase when it exactly matches that intent. A foreign/moved
head, changed policy or host, missing proof, or unknown staging artifact
requires administrator reconciliation, not adoption or overwrite. The
installed service exposes only the short-lived root-read and workspace-write
transports described above. A valid read lease is accepted solely for exact upload-pack discovery and RPC
on its bound `root` repository. Before every discovery and RPC spawn, the
service repeats the active-generation, owner marker, private path, durable
bundle, sole protected-ref, commit, tree, and complete-graph verification used
by the proof endpoint. Moved refs, changed state, incomplete graphs, expiry,
wrong generation, wrong Project or repository, and restart fail closed.
Receive-pack discovery and RPC return `403` for a valid read lease and the backend
forces receive-pack disabled for every non-writer identity. Only a valid write
lease can invoke receive-pack, and its checked hook limits updates to that
lease's proposal namespace; no installed transport identity can write a protected ref. Lease issuance
and transport share a 16-operation limit reserved before body reads or live
verification. Transport re-authenticates the lease after verification and
immediately before spawning Git. Shutdown stops admission synchronously,
invalidates all leases, drains every admitted verification or backend, and only
then releases storage ownership; a read whose proof was blocked at shutdown
cannot spawn Git or send a later response.

### Ordinary verifier HTTP contract

Native startup authenticates the query credential to exact `GET /v1/identity`
without query parameters. The only successful body is:

```json
{
  "schemaVersion": 1,
  "serviceId": "ordinary-main",
  "role": "native-query",
  "scope": ["admission:read", "attempt:read"]
}
```

Only after that exact attestation succeeds may startup inject the HTTP verifier.
The verifier uses exact `POST /v1/admission-verifications` for descriptor
admission and exact `POST /v1/current-attempt-verifications` for current
attempts, with no query parameters. Both requests contain `schemaVersion: 1`, a
fresh UUID `requestId`, and only the complete input tuple of the corresponding
`AdmissionVerifier` method. The admission request contains `descriptor`,
`descriptorDigest`, `hostId`, and `capacity`. The current-attempt request
contains `reviewId`, `attemptId`, `descriptorDigest`, `admissionGeneration`,
`hostId`, and `capacity`.

A successful response is `200 application/json`, sets `Cache-Control: no-store`,
and contains only the complete request plus `serviceId: "ordinary-main"` and
`authorized: true`. Native Git requires exact deep equality with its request,
including the nonce and every descriptor field. Responses are limited to 64
KiB. This makes a response replay for another request or tuple invalid. Missing
or invalid authentication returns `401`; authenticated wrong-role or wrong-scope
access returns `403`; a foreign Project or repository returns `404`; missing,
expired, revoked, stale, superseded, or tuple-mismatched admission returns `409`;
and an unavailable or inactive ordinary service returns `503`. Native Git treats
every non-`200` status identically as failed verification. It follows no
redirect, retries nothing, and accepts no malformed, partial, additional-field,
wrong-service, wrong-scope, oversized, cacheable, timed-out, or transport-failed
response.

### Ordinary-authority proof HTTP contract

The distinct `ordinaryCi.identity` credential authenticates only four
read-only native endpoints. Exact `GET /v1/ordinary-authority/identity` returns
only schema version `1`, service ID `native-main`, role
`ordinary-authority-reader`, and ordered scope `policy:read`,
`review-event:read`, `attempt:read`.
It is not accepted as a native Git identity.

Exact `POST
/v1/projects/<project>/repositories/<repository>/ordinary-authority/policy`
accepts only schema version `1`, a fresh UUID `requestId`, and `protectedRef`.
It returns the echoed request ID and canonical registered Project, repository,
ref, policy/review/job-set revisions, and lexically sorted required job names.
The request cannot select revisions, jobs, hosts, or capacities. Native Git
stores and returns no per-Project `eligibleAssignments`; ordinary authority
derives the complete sorted assignment set from its global operator-owned
`hosts[].capacities[]` configuration.

Exact `POST
/v1/projects/<project>/repositories/<repository>/ordinary-authority/review-event`
accepts only schema version `1`, a fresh UUID `requestId`, and the `eventId`,
`reviewId`, and `jobName` selector. The server derives Project, repository,
protected ref, expected head, candidate commit/tree, and policy revisions from
the immutable stored review envelope. Under the protected-ref serializer it
rereads that envelope and the live review status, then returns only the echoed
request ID and the exact canonical stored non-executable event. It does not
enumerate the outbox or accept an image, script, command, descriptor, ref,
candidate object, policy revision, or administrator selector. Missing,
fabricated, foreign, review/job-mismatched events are concealed as `404`;
policy, protected-head, or proposal movement after review storage returns `409`.

Exact `POST
/v1/projects/<project>/repositories/<repository>/ordinary-authority/current-attempt`
accepts only schema version `1`, a fresh UUID `requestId`, `reviewId`, `jobName`,
and `attemptId`. Under the same protected-ref serializer used for issuance and
revocation, it returns the current unrevoked schema-2 issuance projected to
schema version `1`: complete descriptor and descriptor digest, admission
generation, review and attempt IDs, host, and capacity. It rejects missing,
foreign, unissued, revoked, replaced, stale-review, or current-policy-drifted
tuples. It never reads or returns candidate blob bytes.

All four routes reject alternate methods, paths, and query parameters. Proof
POST bodies require exact `application/json`, reject additional fields, and are
limited to 64 KiB. Successful responses are exact JSON, limited to 64 KiB, and
set `Cache-Control: no-store`; all failures contain no proof tuple. The proof credential cannot use
Git upload/receive, review inspection or approval, descriptor derivation,
attempt issuance/revocation, status reporting, promotion, or administration.

### Installed native-root CI proof contract

The schema-7 installed bundle separately exposes an installed-only
`native-root-ci-proof` namespace to its configured `ordinaryCi.identity`.
This namespace does not replace or fall back to the standalone
`ordinary-authority` API above. Exact
`GET /v1/native-root-ci-proof/identity` is available before activation and
returns only schema version `1`, service ID `native-main`, role
`native-root-ci-proof-reader`, ordered scope `imported-policy:read`,
`ordinary-review-event:read`, and the serving generation. Identity is
compatibility attestation, not Project readiness.

Exact `POST
/v1/projects/<project>/repositories/root/native-root-ci-proof/policy` accepts
only schema version `1`, a UUID request nonce, and the exact 64-hex serving
generation. Under the shared root/review operation gate it derives the current
root from the active durable authoritative import and returns the echoed nonce,
serving generation, Project/root identity, complete canonical
`authoritative-v1` policy, and current root `{importNonce, sequence,
protectedRef, commit, tree, policyDigest}`. The policy retains all QEMU and
ordinary-Sysbox job labels, required reviewers, and path reviewer rules.

The sibling `review-event` POST additionally accepts exactly the import nonce,
policy digest, schema-2 event and review IDs, execution kind, and job name.
`qemu` is parsed but concealed as `404`; only `ordinary-sysbox` can be proved.
The service loads the immutable stored envelope, verifies the exact selector,
runs full review liveness, and rechecks both target and envelope while holding
the same serialized gate. Pending, approved, and self-revoked reviews are
eligible while current; approval is not implied. The response repeats the full
policy/current-root envelope, sets `reviewLiveness: current`, and includes the
exact stored schema-2 event.

Known foreign roles receive `403`, unknown credentials `401`, malformed or
non-exact JSON `400`, alternate method/path/query/repository and QEMU selectors
`404`, generation/import/policy/legacy/current-root or live-review conflict
`409`, and inactive, closing, or unavailable proof admission `503`. Requests
and successful responses are bounded to 64 KiB exact JSON with
`Cache-Control: no-store`. No route writes the database, refs, review or
decision records, or grants admission, intake, attempts, results, scheduling,
runtime, promotion, or Project-ready authority.

### Installed native-root admission contract

The installed ordinary service writes only strict state format 6. Its SQLite
schema contains `bundle_activation`, `native_root_admissions`, and
`native_root_admission_requests`, plus `native_root_ci_event_receipts` and
`native_root_ci_demands`; both replay ledgers are independently capped at
100,000 rows. Format 5 and every
other predecessor are rejected byte-for-byte with no
migration. The schema-4 ordinary configuration is unchanged. The serving
generation comes only from the `serve ... GENERATION_ID` argument, and the
native-root proof client pins that same generation, `native-main`, endpoint,
and `ordinaryCi.identity` credential. The global capacity digest is the sorted
`nativeCapacityConfigDigest` over all operator hosts and capacities. No
Project-specific capacity, image, job, or assignment selection is stored.

Exact `POST /v1/native-root-ci-events` uses only the configured webhook
credential. Unknown credentials receive `401`, known other roles `403`, and
exact activation is required before parsing. The body is bounded to 64 KiB,
requires exact `application/json` and no query, and contains only schema version
1, the startup generation, one UUIDv4 admission generation, and the strict
canonical schema-2 `ordinary-sysbox` event. Schema 1, QEMU, unknown fields, and
executable inputs are rejected. The installed schema-7 native configuration
pins this new namespace; the standalone schema-2 service retains its separate
legacy route and no alias connects them.

Preflight is read-only and requires the exact active, unexpired admission,
Project/root, installer generation, capacity digest, current ref/head, complete
policy revisions, and required ordinary job. An exact receipt replay is `202`
without upstream proof only while that same admission remains active; changed
reuse is `409`. Replay is checked before the permanent 100,000-row cap. A new
receipt selects import nonce and policy digest only from the admission, obtains
a fresh native ordinary-event proof, requires canonical submitted/proved event
equality and the complete admission identity, then repeats activation,
fresh-clock admission, replay, cap, policy, and full root checks in one
`BEGIN IMMEDIATE` insertion transaction. A lease-only renewal with unchanged
identity/root may converge; revocation, replacement, expiry, root movement, or
changed identity while proof is pending conflicts without mutation. Each newly
accepted receipt and its one `queued` ordinary-Sysbox demand commit in that
same transaction. Demand insertion failure rolls both rows back; replay of a
known receipt requires its paired demand and cannot create or requeue one.
The demand is only a durable intent, not an executable claim or job result.

The primary key is `(admission_generation,event_id)`, so a new admission may
record the same deterministic event only after fresh proof. Each row retains
the canonical event and digest plus services, generation, Project/root, import,
policy, root snapshot, capacity digest, and receipt time. Rows are never
deleted. Startup and read-only check-state stream at most 100,000 rows and
verify canonical bytes/digest, event/row identity, the joined admission's
immutable identity and policy job/revisions, monotonic historical roots, and
exactly one paired demand. Queued demands whose admission or root is no longer
current are invalid; revocation, expiry, root movement, and generation or
capacity replacement supersede queued demand without reviving historical work.
Inactive historical receipts are valid. Validation performs no repair or
network request.

`202` means the historical receipt and its demand exist. It is not review
liveness, approval, dispatch eligibility, claim, attempt, result, execution, or
promotion authority. No legacy event dispatcher is wired because its flat
schema-1 payload and acknowledgement are incompatible.

Exact `GET /v1/native-root-admission/identity` derives its response from the
presented credential. The registrar response has role
`native-root-admission-registrar` and ordered scopes
`imported-root-admission:write`, `imported-root-admission:revoke`; the query
response has role `native-root-admission-reader` and scope
`imported-root-admission:read`. Both include schema version 1,
`ordinary-main`, and `servingGenerationId`. Native Git readiness attests only
the latter exact identity and no longer treats legacy attempt-query identity as
readiness. Identity remains available before activation.

The replay-ledger Project/root POST suffixes are `register`, `current`, and `revoke`.
Every body is strict schema version 1 with a UUIDv4 `requestId` and exact
`generationId`; `current` and `revoke` also require a UUIDv4
`admissionGeneration`. Registration accepts no other field and first obtains a
fresh verified native-root policy proof. Proof outage is `503`, stale proof
`409`, and absent proof `404`, all without ordinary-state mutation. A stored
exact request replay returns its historical response before another proof
request; reuse for another operation, path tuple, or body is `409`.
All exact replays, including `current`, acknowledge a historical operation,
not present eligibility. Consumers MUST generate a fresh UUIDv4 `requestId`
for every current-validity check. Replaying a successful `current` after
revocation or expiry may return its original `200`; a fresh request returns
`404` for that admission generation.

An additional query-only Project/root POST suffix, `discover`, accepts exactly
schema version 1, a fresh UUIDv4 `requestId`, and the current installer
`generationId`, without an `admissionGeneration`. It returns the same no-store
admission envelope as `current` only for the one active, unexpired Project/root
admission bound to the current installer generation and global capacity digest.
It never fetches upstream, renews, expires, registers, or changes state, and
does not consume the capped request-replay ledger. A repeated discovery is a
fresh observation, not a historical replay; after revocation or expiry it
returns `404`. Discovery supplies only a candidate generation to a separate
native admission resolver. It is not a review-event proof, demand, claim,
attempt, result, approval, or runnable-Project authority. Event receipt
still independently verifies the current admission and native review proof.
Unknown credentials receive `401`, known wrong-role credentials receive `403`,
and valid query credentials from a different Project receive `404`. The
complete admission response is bounded to 64 KiB before registration commits;
an oversized response rolls back registration and returns `413`.

Business POSTs require successful activation in the current process and the
exact durable generation/token binding. Restart preserves valid admissions but
requires activation again. A successful activation with another installer
generation or global capacity digest marks every old active row `replaced`;
rollback never revives one. Each admission stores a UUIDv4 generation, binding
digest, both service identities, installer generation, Project/root, import
nonce, root sequence/ref/commit/tree, policy digest and full canonical policy,
capacity digest, finite expiry, state, and creation/refresh/end times. The
binding digest excludes only the moving root sequence/commit/tree. An identical
active binding renews the same generation and accepts only an identical or
higher current root; a lower sequence or changed head at the same sequence is
`409` without renewal. Import, policy, installer generation, or capacity
change replaces it. Expiry or revocation requires a new generation.

Successful responses contain schema version 1, `ordinary-main`, echoed request
ID, serving generation, and an admission envelope with schema version 1,
admission generation, capacity digest, expiry, and imported-root
`{serviceId, servingGenerationId, projectId, repositoryId: root, currentRoot,
policy}`. A fresh current request performs no upstream fetch, refresh, or creation and returns
only the exact active, unexpired admission in the present generation/capacity
context. Revocation grants no execution authority. Legacy operator-admission,
native-event, claim, result, old verification, and attempt surfaces are absent
and return `404`. Imported drafts remain non-runnable, and no host lifecycle,
Project-ready, execution, scheduling, result, or promotion path is activated.

### Native review-event outbox

Creating an immutable review writes one strict immutable envelope containing
exactly `{review, events}` to that repository's owned proposal directory. The
review identity binds the sorted complete required-job-name set, and `events`
contains exactly one event in that order for every bound job. The service writes
the complete mode-`0600` envelope to a uniquely named staging file, fsyncs it,
publishes it without replacement by hard-linking it to the review path, and
fsyncs the proposal directory before returning success. It then removes the
staging link and fsyncs the staging directory. Startup removes only a strictly
named, caller-owned mode-`0600` staging link whose device and inode exactly
match its expected published review; foreign, unpublished, or mismatched state
is rejected unchanged. A partial event set or repository-wide duplicate event
ID is invalid startup state, and review creation fails before publication if
the bounded outbox cannot accept the whole set. Event bytes are the exact
`dim.native.review-job.available` JSON defined by `CI-NATIVE-DELIVERY-001`;
they contain review and policy provenance but no descriptor or executable
field.

One service-owned dispatcher sends the oldest undelivered ordinary-Sysbox event
to the fixed ordinary receipt endpoint; QEMU events remain outside this lane.
A separate query-credential resolver obtains the current admission generation
through the read-only `discover` route and checks the Project/root, full
operator policy, current head and required ordinary job before returning only
that generation to the webhook-credential dispatcher. The dispatcher neither
registers admissions nor receives the query credential. It observes an exact
non-cacheable durable ordinary receipt before marking
the event delivered, uses the same event ID and bytes after timeout or crash,
and never treats delivery as job success. Startup validates event schema,
digest, path, owner, mode, review linkage, and the all-required-jobs set before
dispatch. Delivered records compact to `(eventId, eventDigest)` tombstones that
are never age-pruned. The per-repository tombstone cap is 100,000. Exact known
replay remains idempotent at the cap; creating a review whose full event set
would require another tombstone fails with `429` before review or event
publication. Undelivered events are never pruned. The dispatcher has no native scheduler, CI reporter, reviewer,
promoter, Git transport, or ordinary query credential. Transient marker I/O
keeps the event pending and retries; unrecoverable marker integrity failures
withhold native Git readiness rather than leaving a silent healthy dispatcher.

### Ordinary issuer and reporter endpoints

The target ordinary attempt-issuer credential is accepted only on the exact
review-scoped descriptor, attempt issuance, and attempt revocation paths. The
additive package authenticates the bundle's configured
`ordinaryCi.attemptIssuer` as a distinct internal service principal rather than
a native Git scheduler, reviewer, or administrator identity. Descriptor derivation
requires the strict bounded request described below. Issuance requires the
strict request already described below, and `issuanceRequestId` is the ordinary
claim receipt UUID. Exact replay while that attempt remains current returns the
same immutable attempt. Reuse with changed input, after revocation, or after a
replacement attempt conflicts without writing state. Revocation names the same
review, job, attempt, descriptor digest, generation, host, and capacity.
The credential cannot report a result, use upload-pack or receive-pack, inspect
or approve a review, promote, administer, or enumerate unrelated repositories.

The ordinary result-reporter credential is accepted only on the existing exact
review-scoped CI completion path. It submits the native schema-2
`dim.ci.job.completed` event without translation. Native Git writes the
immutable status before acknowledging and returns the same success for an exact
replay. The reporter cannot derive a descriptor, issue or revoke an attempt,
read Git, or promote. Neither service credential can enumerate repositories or
select another Project through request data.

## Inputs and identity

The standalone non-bundle daemon consumes a strict schema-2 configuration with fixed service identity
`native-main`. It pins a trusted regular
Git executable, its filesystem identity, and its exact `git version` output,
one absolute storage root,
registered `(Project ID, repository ID)` tuples, and credentials bound to one
Project and explicit repository IDs. Writer credentials additionally bind one
workspace ID. Configuration rejects duplicate repository tuples, duplicate
usernames, identities naming an unregistered repository, unknown fields, and
malformed identifiers before listening.

Repositories may declare protected-ref review policies with exact policy,
required-review, and required-job-set revisions; required job names; baseline
reviewer IDs; and path-prefix rules that add reviewers. Reviewer and administrator credentials
remain Project/repository scoped. Reviewers have no Git write role.
Administrators can inspect and revoke evidence but cannot approve. Only the
configured `ordinaryCi.attemptIssuer` credential occupies the narrow
descriptor/issue/revoke role; separately configured repository scheduler and CI
identity variants are rejected as obsolete schema-2 input. The role
cannot use smart Git transport, report results, approve, promote, or administer.
The result reporter has no client-selected Project, repository, or job scope;
it can report only a live required job's exact current issued descriptor and
host assignment. Promoter credentials have no Git transport role and cannot
bypass the checked promotion operation.

HTTP repository paths contain only validated Project and repository IDs. The
service resolves them through the startup registry and constructs
`PATH_INFO`; it never accepts a filesystem path from a client. A valid identity
for another Project receives no repository access. Missing or invalid
credentials receive an authentication challenge; authenticated foreign or
unknown repository requests return not found.

## Own-identity endpoint (Contract)

The service exposes exact `GET /v1/identity`, without query parameters, for a
client to verify its authenticated native Git identity. A successful response
is `200` JSON containing only `role`, `projectId`, and `repositoryIds`, plus
`reviewerId` if and only if the authenticated role is `reviewer`. It does not
return the username, password, role-specific writer or CI bindings, Git paths,
executable metadata, other configuration, or any other identity. The endpoint
does not accept an identity selector and cannot enumerate accounts or cross a
Project boundary.

Missing or invalid Basic credentials receive `401` with an authentication
challenge. The endpoint returns `503` without identity data until service
startup has established the pinned Git executable identity and whenever that
identity no longer validates. Every endpoint response uses
`Cache-Control: no-store`.

## Smart-HTTP operations

The service permits these exact protocol operations:

| Operation | Required authority |
| --- | --- |
| `GET .../info/refs?service=git-upload-pack` | Registered reader or writer |
| `POST .../git-upload-pack` with the Git upload content type | Registered reader or writer |
| `GET .../info/refs?service=git-receive-pack` | Registered writer |
| `POST .../git-receive-pack` with the Git receive content type | Registered writer |

Additional query parameters, methods, endpoints, encoded separators,
unregistered IDs, and mismatched content types are rejected before spawning
Git. The child receives a fixed allowlist of CGI and DIM identity variables,
not the service process environment. Request size, CGI header size, stderr
capture, backend concurrency, HTTP timeouts, and protocol negotiation values
are bounded. Each backend spawn rechecks the executable identity and overrides
repository-controlled hook and receive settings.

## Proposal-only receive policy

Repository initialization rejects symbolic links in registered repository and
hook paths, installs a server-side `pre-receive` policy without following
links, and enables receive-pack only behind the HTTP authorization layer. A workspace
writer may create or fast-forward only:

```text
refs/heads/proposals/<bound-workspace-id>/<safe-name>
```

The hook rejects protected refs, tags, foreign workspace namespaces, malformed
proposal names, and deletion. The forced effective receive configuration
rejects non-fast-forward updates before Git moves any ref. Git's receive
quarantine remains in effect on rejection.

There is no transport identity that may write a protected ref. Host setup may
perform an initial import directly against owned storage before service
exposure, but routine HTTP publication remains proposal-only.

## Immutable complete-tree review

The authenticated review API and CLI resolve the live protected head and
workspace proposal ref through the pinned Git executable. One immutable review
object binds the Project and repository IDs, protected and proposal refs,
expected protected head, candidate commit and tree, all three policy revisions,
the policy digest, proposal writer/workspace identity, required reviewers, and
the complete base-to-candidate diff. Changed-path evidence records additions,
modifications, deletions, renames, copies, type changes, old/new modes and
object IDs, raw path bytes, and symbolic-link targets. Binary-preserving patch
bytes are retained alongside the printable patch.

Path-prefix rules inspect raw old and new path bytes, including both sides of a
rename, and only add required reviewers. An approval names the review object's
single digest and therefore approves the entire candidate tree, never a path
subset. The API accepts approval only from a configured required human
reviewer. Workspace writers, read-only/CI credentials, administrators, foreign
Projects, and unrequired reviewers cannot approve. Administrators may revoke
an approval; reviewers may revoke only their own.

Proposal, approval, and revocation records are mode-`0600`, immutable,
fsync-published files below the caller-owned bare repository. Startup rejects
symbolic links, unexpected entries, malformed records, identity/path mismatch,
or oversized state. Status rereads live refs and current configuration. Any
protected head, proposal commit/tree, policy/revision, writer, or reviewer
identity drift makes approval stale. Restart with unchanged state preserves
approval but grants no additional authority.

## Exact CI evidence and protected promotion

The status API accepts only the native schema-2 `dim.ci.job.completed` event
envelope. Its payload binds the review ID, full canonical candidate execution
descriptor and digest, authenticated job, server-issued attempt ID and number,
immutable host/capacity assignment, start and finish times, terminal completion,
result, and bounded stdout/stderr byte counts and digests. The
format is a DIM event contract and makes no claim of GitHub Actions or provider
API compatibility. One immutable mode-`0600` record may exist for each review,
job, and attempt; an exact replay is idempotent and conflicting evidence for the
same attempt is rejected. Startup validates record schema, digest, path, mode,
and ownership. Promotion considers only the current durable, unrevoked
attempt-issuer-created attempt for every currently required job and requires
each to be `success` with `exited/0` from the configured
`ordinaryCi.resultReporter` credential.

For native ordinary CI, the issued attempt and completed event additionally
bind evidence class `candidate-controlled` and the canonical execution
descriptor required by `CI-NATIVE-CANDIDATE-JOB-001`: candidate config and
script object/digests, normalized fixed argv, operator job-base and runner-base
digests, effective bounds, host, and capacity. Native Git derives the candidate
blobs from the exact tree and uses the operator capacity's requested job base
only after authenticated ordinary admission verifies the exact image/assignment;
no webhook or CI reporter may supply or replace those fields. A stale, revoked, superseded,
partial, or descriptor-mismatched report cannot satisfy promotion. Exact replay
is idempotent only when the entire terminal record is identical.

Attempt issuance accepts only `issuanceRequestId`, `jobName`, the expected
descriptor digest, admission generation, operator job-base and runner-base
images, bounds, `hostId`,
and `capacity`. Under the protected-ref serializer, native Git derives the full
descriptor through a non-locking helper, compares its digest, asks the ordinary
admission verifier to confirm the exact descriptor and assignment, then writes
one immutable schema-2 attempt. Exact replay of a still-current request ID
returns the existing attempt. Changed reuse or replay after replacement or
revocation conflicts and creates no record. Revocations repeat the descriptor
digest and assignment and must match their issuance.

The ordinary-admission verifier is mandatory at issuance, reporting, and final
promotion evaluation. It confirms the current admission generation and exact
current attempt tuple, including descriptor digest, host, and capacity. Timeout,
outage, rejection, or malformed verifier behavior fails closed before evidence
or protected-ref mutation. The package exposes the narrow verifier interface for
the authenticated ordinary-service client; the executable's unconfigured
default always rejects.

Terminal completion is exactly one of exited with code 0 through 255, signaled
with signal 1 through 64, timed out, output-limit exceeded, lease lost,
cancelled, or executor failure with a safe code. Success requires exited zero;
cancelled requires cancelled completion; every other completion is failure.
Finish cannot precede start, and combined stdout/stderr captured bytes cannot
exceed the descriptor output bound.

Attempt, revocation, envelope, and status-record parsers accept only schema
version 2. Startup rejects version-1 evidence unchanged. It does not migrate,
rewrite, delete, alias, or union obsolete state; immutable reviews and human
approvals are preserved so an operator can explicitly issue fresh evidence.

The attempt-issuer-only descriptor endpoint is exact
`POST /v1/projects/{project}/repositories/{repository}/reviews/{review-id}/ordinary-execution-descriptors`
with no query parameters. Its exact JSON body contains only `jobName`,
`admissionGeneration`, digest-pinned `runnerBaseImage`, and `bounds` containing
positive canonical decimal strings for `cpu`, `memoryBytes`, `pids`,
`wallClockSeconds`, and `outputBytes`. The body is limited to 64 KiB and unknown
fields are rejected. Project, repository, ref, candidate object IDs, and policy
revisions come only from the immutable review. The response contains only
`reviewId`, the canonical `descriptor`, and its `digest`; obtaining it creates
no attempt, status, or other durable state and grants no Git transport read.

The named job must remain required by current policy. Pending, approved, and
revoked reviews are eligible because ordinary CI may inform human approval;
stale reviews conflict. Under the protected-ref serializer, the service checks
status before loading the bounded candidate config and script blobs and checks
status again afterward. The second check detects a concurrent proposal
fast-forward, because smart Git receive does not participate in that serializer.
Unchanged review and attempt-issuer inputs deterministically return the same
`{reviewId, descriptor, digest}` tuple.

Native ordinary success is evidence that the selected candidate-controlled
tests executed within the recorded sandbox and exited zero. It may satisfy a
protected policy condition that explicitly requires a `candidate-controlled`
job, but is not independent verification or blanket proof of correctness.
Status and promotion responses expose that class and provenance without calling
it independent. Product maintainers use the test definition and result together
with changed requirements and implementation to assess regressions.
Infrastructure security review separately follows secret exposure,
protected-ref authority, host/runtime privilege, and trusted capability
elevation. Human approval of the exact complete tree and checked
compare-and-swap remain separate mandatory conditions.

One mode-`0600` rollback-journal SQLite database below the canonical storage
root gives the process a kernel-released ownership lease through a continuously
held exclusive transaction. The database records the storage root filesystem
identity, and startup rejects a non-canonical or symbolic-link root, a
symbolic-link, linked, malformed, wrong-mode, wrong-owner, or wrong-root owner
database, and filesystems outside the explicit supported local Linux
allowlist. Duplicate service startup therefore fails across separate network
namespaces that mount the same volume, without PID liveness checks. Process
death releases the transaction while retaining validated owner metadata, so a
legitimate replacement can acquire the same database without stale-lock
cleanup or migration.
The promotion API accepts only a Project/repository-scoped promoter identity.
The service serializes approval, revocation, CI status, and promotion decisions
per repository/protected ref. While inside that boundary, promotion rereads the
review, current policy, live protected and proposal refs, candidate tree,
current complete human approvals, exact current CI evidence, and descendant
ancestry. After human approval, it revalidates every current ordinary admission,
attempt descriptor, and assignment before ancestry and CAS. It then executes
one Git `update-ref --stdin` transaction that locks
and verifies the proposal ref at the reviewed candidate while comparing and
swapping the protected ref from the expected head to that candidate. Every
mismatch leaves the protected ref unchanged, and concurrent candidates from
one expected head permit one winner. Retry returns `already-current` only for
the exact candidate with otherwise current evidence. Deletion, force, generic
administrator writes, and direct smart-HTTP protected writes remain absent.

## Verification

Paired development tests use the real pinned Git executable and disposable
bare repositories over HTTP. They prove two Projects are isolated, authorized
clone and fetch work, an authorized workspace can update only its proposal
namespace, and reader pushes, foreign repositories, invalid credentials,
traversal, tags, cross-workspace refs, protected direct/force/deletion pushes,
and unsafe refs fail without changing the tested bare refs. Adversarial tests
also cover redirected hooks, repository and hook symbolic links, executable
replacement, and malformed uploads followed by a successful liveness request.
The review driver creates a real candidate with additions, deletion, rename,
mode change, and symbolic-link change; inspects exact refs, SHAs, paths, and
status through the API and CLI; and proves whole-tree path-owner approval,
revocation, identity/ref/tree/policy staleness, restart durability, Project and
role denials. The promotion driver issues and replays exact descriptor-bound
attempts before recording per-job exited-zero terminal evidence, restarts the
service, compares real `rev-parse` values before and after promotion, and proves
idempotent retry. Competing real candidates prove exactly
one CAS winner, while real processes in separate Docker network namespaces
cannot acquire the same shared-volume storage root. That isolation test also
proves rejection occurs before the contender's listen/mutation marker and that
a replacement acquires ownership after the first process is killed.
Missing, fabricated-future, late, revoked, replaced, failed-current,
nonterminal, foreign, descriptor/host mismatched, generation-rotated,
verifier-outage, malformed terminal/output, injected, stale-policy/head, and
non-descendant cases leave the protected ref unchanged. Startup rejects each
version-1 evidence record without rewriting it; smart-HTTP force and deletion
denials remain in the transport gate.

The ordinary descriptor driver additionally proves exact pending-review replay,
strict body rejection, foreign-scope concealment, wrong-role denial, no attempt
or status writes, stale proposal rejection, and a deterministic proposal move
during candidate blob loading. The attempt-issuer credential is also denied
both upload-pack discovery and RPC while reader and writer fetch remain allowed.
The role matrix proves `attemptIssuer` can derive a descriptor and issue or
revoke only its exact attempt, while identity, webhook, reporter, query, host,
reviewer, administrator, promoter, and obsolete generic scheduler/CI
credentials cannot derive one.
The ordinary-authority review-event driver compares the real HTTP proof bytes
with the canonical event retained by the immutable review envelope, compares
review bytes and protected/proposal refs before and after, and proves fabricated,
foreign, stale, moved-proposal, and review/job selector mismatches fail closed.
