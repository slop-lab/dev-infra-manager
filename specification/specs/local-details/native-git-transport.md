# Native Git Transport and Review Evidence

**Kind: Implementation profile**

## Scope

`@slop-lab/dim-native-git` is DIM-owned Git smart-HTTP transport plus durable
complete-tree human-review evidence. It supplies registered repository storage,
authenticated read transport, workspace-scoped proposal pushes, immutable
review objects, and approval/revocation. It does not implement issues, pull
requests, CI status evidence, merge policy, or protected-ref promotion.

The package is additive and not yet selected by core Project lifecycle code.
Managed and external Gitea remain the current lifecycle implementation while
the native path is independently reviewed and completed.

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
required-review, and required-job-set revisions; baseline reviewer IDs; and
path-prefix rules that add reviewers. Reviewer and administrator credentials
remain Project/repository scoped. Reviewers have no Git write role.
Administrators can inspect and revoke evidence but cannot approve.

HTTP repository paths contain only validated Project and repository IDs. The
service resolves them through the startup registry and constructs
`PATH_INFO`; it never accepts a filesystem path from a client. A valid identity
for another Project receives no repository access. Missing or invalid
credentials receive an authentication challenge; authenticated foreign or
unknown repository requests return not found.

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

## Deferred CI and promotion authority

The review surface satisfies the human complete-tree evidence portion of
`TRUST-PROMOTION-001`; it does not record CI results and cannot promote.
`TRUST-PROMOTION-CAS-001` remains fail closed: no merge or promotion endpoint,
maintainer identity, or administrator direct-write path exists. Later work must
add exact-head CI evidence and a distinct host-only serialized compare-and-swap
operation without changing the proposal-only receive policy.

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
role denials, and unchanged protected refs.
