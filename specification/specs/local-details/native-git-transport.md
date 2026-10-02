# Native Git Transport Foundation

**Kind: Implementation profile**

## Scope

`@slop-lab/dim-native-git` is the initial DIM-owned Git smart-HTTP transport.
It supplies only registered repository storage, authenticated read transport,
and workspace-scoped proposal pushes. It does not implement issues, pull
requests, review evidence, CI status evidence, merge policy, or protected-ref
promotion.

The package is additive and not yet selected by core Project lifecycle code.
Managed and external Gitea remain the current lifecycle implementation while
the native path is independently reviewed and completed.

## Inputs and identity

Startup consumes a strict schema-1 configuration. It pins an absolute Git
executable and its exact `git version` output, one absolute storage root,
registered `(Project ID, repository ID)` tuples, and credentials bound to one
Project and explicit repository IDs. Writer credentials additionally bind one
workspace ID. Configuration rejects duplicate repository tuples, duplicate
usernames, identities naming an unregistered repository, unknown fields, and
malformed identifiers before listening.

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
capture, HTTP timeouts, and protocol negotiation values are bounded.

## Proposal-only receive policy

Repository initialization installs a server-side `pre-receive` policy and
enables receive-pack only behind the HTTP authorization layer. A workspace
writer may create or fast-forward only:

```text
refs/heads/proposals/<bound-workspace-id>/<safe-name>
```

The hook rejects protected refs, tags, foreign workspace namespaces, malformed
proposal names, deletion, and non-fast-forward proposal updates before Git
moves any ref. Git's receive quarantine remains in effect on rejection.

There is no transport identity that may write a protected ref. Host setup may
perform an initial import directly against owned storage before service
exposure, but routine HTTP publication remains proposal-only.

## Deferred promotion authority

This foundation does not satisfy the positive promotion evidence required by
`TRUST-PROMOTION-001` or the serialized atomic update required by
`TRUST-PROMOTION-CAS-001`. Those contracts remain fail closed: no review or
promotion endpoint exists, and no administrator or agent direct-write path is
substituted for them. Later work must add complete-tree review and exact-head
CI evidence before introducing a distinct host-only compare-and-swap operation.

## Verification

Paired development tests use the real pinned Git executable and disposable
bare repositories over HTTP. They prove two Projects are isolated, authorized
clone and fetch work, an authorized workspace can update only its proposal
namespace, and reader pushes, foreign repositories, invalid credentials,
traversal, tags, cross-workspace refs, protected direct/force/deletion pushes,
and unsafe refs fail without changing the tested bare refs.
