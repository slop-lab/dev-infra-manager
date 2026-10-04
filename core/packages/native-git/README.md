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
Dedicated scheduler identities issue and revoke current job attempts but cannot
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

Example schema-1 configuration:

```json
{
  "schemaVersion": 1,
  "host": "127.0.0.1",
  "port": 9080,
  "storageRoot": "/var/lib/dim/native-git",
  "gitExecutable": "/usr/bin/git",
  "gitVersion": "2.43.0",
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
`dim.ci.job.completed` schema-1 event envelope. The payload repeats the
server-issued attempt ID and exact repository, protected ref, expected head,
candidate commit and tree, policy/review/job-set revisions, configured job
name, attempt number, and terminal result. This is a DIM event contract, not an emulation of
GitHub Actions or another provider API. Records are immutable, restart-checked,
and conflict when the same job attempt is reported with different evidence.

Only the current, unrevoked issued attempt can be reported or satisfy promotion.
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
requires exact successful terminal evidence and descendant ancestry; then uses
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
