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
Dedicated scheduler identities derive candidate ordinary-execution descriptors
and issue and revoke current job attempts, but cannot use Git transport or
report results. Dedicated CI identities can report only their configured job
and issued attempt, and only a dedicated promoter identity can request the
checked promotion transaction.
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
      "role": "ci",
      "username": "source-ci",
      "password": "replace-with-random-secret",
      "projectId": "project-a",
      "repositoryIds": ["root"],
      "jobName": "source"
    },
    {
      "role": "ci",
      "username": "security-ci",
      "password": "replace-with-random-secret",
      "projectId": "project-a",
      "repositoryIds": ["root"],
      "jobName": "security"
    },
    {
      "role": "scheduler",
      "username": "host-scheduler",
      "password": "replace-with-random-secret",
      "projectId": "project-a",
      "repositoryIds": ["root"]
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

`ordinaryCi.endpoint` is exactly the private Compose origin shown above. All
four ordinary-service usernames and passwords must be pairwise distinct and
must not equal any native Git identity username or password. At startup the
executable uses only `query` to authenticate `GET /v1/identity`; the response
must attest schema 1, service ID `ordinary-main`, role `native-query`, and the
exact ordered scope `admission:read`, `attempt:read`. The verifier is injected
only after that attestation succeeds. An absent `ordinaryCi` object preserves
the rejecting verifier, so CI attempt, result, and promotion operations remain
fail closed.

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
  `policy:read`, `attempt:read`.
- `POST /v1/projects/<project>/repositories/<repository>/ordinary-authority/policy`,
  accepting only a fresh request UUID and exact protected ref. It returns the
  registered Project/repository/ref, current policy revisions, and sorted
  required job names. It does not accept or return host/capacity eligibility.
- `POST /v1/projects/<project>/repositories/<repository>/ordinary-authority/current-attempt`,
  accepting only a fresh request UUID plus exact review, job, and attempt IDs.
  It returns the complete canonical current unrevoked assignment projected from
  the immutable schema-2 attempt record.

Both proof requests require exact JSON, reject query parameters and bodies over
64 KiB, and return `Cache-Control: no-store`. Missing, foreign, unissued,
revoked, replaced, stale-review, or current-policy-drifted tuples return no
proof. Responses contain no credentials, reviewer rules, patches, or candidate
blob bytes.

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

The dedicated scheduler identity first issues the current attempt through
`POST .../reviews/<review-id>/job-attempts`; it may revoke that attempt through
`POST .../job-attempt-revocations`. CI reports use the native
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
normalized fixed argv, job-image digest, operator runner-base digest, effective
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

Before issuing an attempt, the scheduler obtains that descriptor through exact
`POST /v1/projects/<project>/repositories/<repository>/reviews/<review-id>/ordinary-execution-descriptors`.
The request has no query parameters, is bounded to 64 KiB, requires exact
`application/json`, and accepts only:

```json
{
  "jobName": "source",
  "admissionGeneration": "generation-7",
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
package now supplies the complete-tree proposal, human review, exact CI
evidence, and serialized compare-and-swap transaction required by
`TRUST-PROMOTION-001` and `TRUST-PROMOTION-CAS-001`. Protected-write authority
exists only inside that checked host operation; smart HTTP remains
proposal-only and has no administrator bypass. Core lifecycle wiring, service
deployment/restart, UI, and independent-host CI gates remain separate work.
Independent CI, when a Project requires it, must use a separately selected
command definition and evidence class; native ordinary candidate self-tests do
not acquire that label by running on another host.
