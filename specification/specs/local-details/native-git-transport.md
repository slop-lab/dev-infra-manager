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
schema-1 startup configuration adds exactly this required dependency object:

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
    }
  }
}
```

The endpoint is fixed to the Compose-network origin, follows no redirect, and
must attest the exact service identity before native Git reports ready. The
query credential is scoped only to admission and current-attempt/result queries
for the repository tuple being evaluated. It cannot admit policy, claim
capacity, report a result, enumerate hosts, or mutate scheduler state. It is
distinct from every Git, reviewer, administrator, promoter, scheduler,
CI-result, readiness, and host credential.

The ordinary identity credential can attest only the exact configured native
service and repository tuple. The attempt-issuer credential is a native
scheduler role constrained to one exact live ordinary admission generation,
repository/protected tuple, required job, and newly issued current attempt; it
cannot report. The result-reporter credential is a separate native CI role that
can report only the terminal result for that exact issuer-created current
attempt and job; it cannot issue or revoke. Neither role can read Git, approve,
promote, administer, enumerate unrelated Projects, or act when the ordinary
admission or native identity check is absent, stale, or mismatched.

These credentials and endpoints do not select native Git for Project lifecycle.
Until a separate native Project/repository state adapter is specified and
implemented, the native service starts with no admitted Project and rejects
Project, repository, ordinary admission, attempt, and result mutation.
The four service credentials are not Git transport identities and are not
accepted by generic reviewer, administrator, CI, scheduler, or promotion
routes; each is accepted only by its fixed role-specific endpoint.

## Inputs and identity

Startup consumes a strict schema-1 configuration. It pins a trusted regular
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
Administrators can inspect and revoke evidence but cannot approve.
Scheduler credentials issue and revoke durable current attempts but cannot
report results or promote. CI credentials additionally bind one job name and cannot report another job;
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

The status API accepts only the native schema-1 `dim.ci.job.completed` event
envelope. Its payload binds the review's Project, repository, protected ref,
expected head, candidate commit and tree, policy, review, and job-set revisions,
plus the authenticated job name, server-issued attempt ID and number, and terminal result. The
format is a DIM event contract and makes no claim of GitHub Actions or provider
API compatibility. One immutable mode-`0600` record may exist for each review,
job, and attempt; an exact replay is idempotent and conflicting evidence for the
same attempt is rejected. Startup validates record schema, digest, path, mode,
and ownership. Promotion considers only the current durable, unrevoked
scheduler-issued attempt for every currently required job and requires each to be `success` from the currently
configured identity for that job.

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
ancestry. It then executes one Git `update-ref --stdin` transaction that locks
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
role denials. The promotion driver issues exact attempts before recording per-job terminal evidence,
restarts the service, compares real `rev-parse` values before and after
promotion, and proves idempotent retry. Competing real candidates prove exactly
one CAS winner, while real processes in separate Docker network namespaces
cannot acquire the same shared-volume storage root. That isolation test also
proves rejection occurs before the contender's listen/mutation marker and that
a replacement acquires ownership after the first process is killed.
Missing, fabricated-future, late, revoked, failed-current, nonterminal, foreign,
tuple-mismatched, injected, revoked, stale-policy/head, and non-descendant cases
leave the protected ref unchanged; smart-HTTP force and deletion denials remain
in the transport gate.
