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

The unimplemented control-plane bundle target runs the service as the `native-git`
member defined by `INSTALLER-CONTROL-PLANE-001`. It runs as `10001:10001`,
listens at `0.0.0.0:8080`, stores all repository and evidence bytes below
`/var/lib/dim-native-git`, and receives only that service's private volume and
read-only config, readiness-token, and activation-token files. Its strict
schema-2 startup configuration pins `serviceId` to `native-main` and adds
exactly this required dependency object:

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
Until a separate native Project/repository state adapter is specified and
implemented, the native service starts with no admitted Project and rejects
Project, repository, ordinary admission, attempt, and result mutation.
The five service credentials are not Git transport identities and are not
accepted by generic reviewer, administrator, CI, scheduler, or promotion
routes; each is accepted only by its fixed role-specific endpoint.

The webhook credential is outbound-only. Native Git uses it only to submit the
exact durable review-job event in `CI-NATIVE-DELIVERY-001`. Ordinary CI cannot
use it against native Git, and possession grants no review, descriptor,
attempt, result, Git, or promotion authority. The webhook never carries an
executable selector.

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

The distinct `ordinaryCi.identity` credential authenticates only three
read-only native endpoints. Exact `GET /v1/ordinary-authority/identity` returns
only schema version `1`, service ID `native-main`, role
`ordinary-authority-reader`, and ordered scope `policy:read`, `attempt:read`.
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
/v1/projects/<project>/repositories/<repository>/ordinary-authority/current-attempt`
accepts only schema version `1`, a fresh UUID `requestId`, `reviewId`, `jobName`,
and `attemptId`. Under the same protected-ref serializer used for issuance and
revocation, it returns the current unrevoked schema-2 issuance projected to
schema version `1`: complete descriptor and descriptor digest, admission
generation, review and attempt IDs, host, and capacity. It rejects missing,
foreign, unissued, revoked, replaced, stale-review, or current-policy-drifted
tuples. It never reads or returns candidate blob bytes.

All three routes reject alternate methods, paths, and query parameters. Proof
POST bodies require exact `application/json`, reject additional fields, and are
limited to 64 KiB. Successful responses are exact JSON with `Cache-Control:
no-store`; all failures contain no proof tuple. The proof credential cannot use
Git upload/receive, review inspection or approval, descriptor derivation,
attempt issuance/revocation, status reporting, promotion, or administration.

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

One service-owned dispatcher sends the oldest undelivered event to the fixed
ordinary webhook endpoint. It records acknowledgement durably before marking
the event delivered, uses the same event ID and bytes after timeout or crash,
and never treats delivery as job success. Startup validates event schema,
digest, path, owner, mode, review linkage, and the all-required-jobs set before
dispatch. Delivered records compact to `(eventId, eventDigest)` tombstones that
are never age-pruned. The per-repository tombstone cap is 100,000. Exact known
replay remains idempotent at the cap; creating a review whose full event set
would require another tombstone fails with `429` before review or event
publication. Undelivered events are never pruned. The dispatcher has no native scheduler, CI reporter, reviewer,
promoter, Git transport, or ordinary query credential.

### Ordinary issuer and reporter endpoints

The target ordinary attempt-issuer credential is accepted only on the exact
review-scoped descriptor, attempt issuance, and attempt revocation paths. The
currently additive package calls this its scheduler role; binding the bundle's
configured `ordinaryCi.attemptIssuer` credential to that same narrow role is
unimplemented target wiring, not shipped integration. Descriptor derivation
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

Startup consumes a strict schema-2 configuration with fixed service identity
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
Administrators can inspect and revoke evidence but cannot approve. The current
additive package calls its narrow descriptor/issue/revoke identity `scheduler`.
In the unimplemented control-plane target, only the configured
`ordinaryCi.attemptIssuer` credential occupies that role; no separately
configured repository scheduler identity is accepted for those routes. The role
cannot use smart Git transport, report results, approve, promote, or administer.
CI credentials additionally bind one job name and cannot report another job;
promoter credentials have no Git transport role and cannot bypass the checked
promotion operation.

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
scheduler-issued attempt for every currently required job and requires each to
be `success` with `exited/0` from the currently configured identity for that job.

For native ordinary CI, the issued attempt and completed event additionally
bind evidence class `candidate-controlled` and the canonical execution
descriptor required by `CI-NATIVE-CANDIDATE-JOB-001`: candidate config and
script object/digests, normalized fixed argv, candidate job image digest,
operator runner-base digest, effective bounds, host, and capacity. Native Git
derives the descriptor from blobs in the exact candidate tree; no webhook or CI
reporter may supply or replace those fields. A stale, revoked, superseded,
partial, or descriptor-mismatched report cannot satisfy promotion. Exact replay
is idempotent only when the entire terminal record is identical.

Attempt issuance accepts only `issuanceRequestId`, `jobName`, the expected
descriptor digest, admission generation, runner-base image, bounds, `hostId`,
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
Unchanged review and scheduler inputs deterministically return the same
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
during candidate blob loading. Scheduler credentials are also denied both
upload-pack discovery and RPC while reader and writer fetch remain allowed. The
target role matrix proves `attemptIssuer` can derive a descriptor and issue or
revoke only its exact attempt, while identity, webhook, reporter, query, host,
reviewer, administrator, and promoter credentials cannot derive one.
