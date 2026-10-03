# `@slop-lab/dim-web`

`@slop-lab/dim-web` is the authenticated service for the first bounded DIM
reviewer-web slice. It serves a same-origin reviewer page and exposes one
configured native Git reviewer identity to one explicitly bound local reviewer
account without returning the native Basic credential or a raw native review
response to the browser. Other configured accounts can inspect evidence but
cannot mutate reviewer decisions.

The browser page signs in, creates immutable review evidence from exact refs,
opens an exact review ID, displays allowlisted metadata, changed paths, and
literal patch text, approves that exact review, revokes only the configured
reviewer's active approval, and signs out. It keeps the CSRF token in memory and
the session cookie remains HttpOnly. The service does not expose rejection,
administrator revocation, host administration, promotion, CI reporting,
arbitrary native operations, or a generic proxy. Deployment integration remains
outside this slice.

## Security boundary

The service binds only to `127.0.0.1` or `::1`. Before binding, it authenticates
to exact native `GET /v1/identity` and requires the configured role, Project,
ordered repository set, and reviewer ID to match. Authentication failure,
native unavailability, a non-reviewer role, or any scope mismatch fails startup.

The absolute startup configuration path must name a caller-owned, non-symlink,
mode-`0600` regular file no larger than 64 KiB. Local account passwords are
stored only as `scrypt` hashes. The native Basic username and password exist
only in that trusted file and server memory.

Password verification uses one process-global token bucket with a burst of five
derivations and a refill of one token per second, plus a maximum of two
concurrent derivations. It neither queues excess work nor partitions capacity
by attacker-controlled account names. Every admitted attempt consumes one token
without refund. A login rejected by either bound receives `429` with
`Retry-After: 1`. Unknown accounts and known accounts with a wrong password
both perform one full derivation and constant-time hash comparison.

Successful login creates an opaque random in-memory session and invalidates
every prior session for that account. The cookie is `HttpOnly`,
`SameSite=Strict`, and scoped to `/`; an HTTPS `publicOrigin` also sets
`Secure`. Sessions have independent idle and absolute expiries. Expired
sessions are pruned before login and session creation, and the process holds at
most 256 sessions. A valid login receives bounded `429` with `Retry-After: 1`
when that capacity is occupied by other accounts. Restarting the process
invalidates every session.

Every unsafe request requires both an exact `Origin` equal to `publicOrigin`
and the session's synchronizer token in `X-DIM-CSRF`. Loopback HTTP origins are
accepted only for local development and verification; other origins must use
HTTPS. The server follows no redirects and bounds request bodies, native
responses, native request time, headers, and HTTP request lifetime.

Approval and revocation use only the startup-attested reviewer credential.
The required `reviewerAccountId` must match exactly one configured local
account. Decision routes compare that identifier with the authenticated
session before native dispatch; authorized and read-only review DTOs expose
`canDecide: true` and `false`, respectively.
Native Git remains the authority for required-reviewer membership, stale tuple
denial, approval ownership, serialization, and persistence. The browser sends
an empty action body and cannot select an approval ID. Self-revocation derives
the configured reviewer's active approval from a fresh exact-review response,
then native Git independently verifies ownership. Successful actions return a
fresh allowlisted review DTO. Administrator revocation remains absent because
the service has no separately configured and attested administrator identity.

Review responses are constructed field by field. Printable `patch` and path
strings remain untrusted JSON data. Raw `patchBytes`, raw path-byte fields,
writer/reviewer/reporter Basic usernames, passwords, and unrecognized native
fields are omitted. Every response is `Cache-Control: no-store` and carries a
deny-all CSP and framing/content-type protections.

Loopback HTTP between this service and native Git does not authenticate the
native server as a network peer. The Basic credential authenticates this
client to whichever process owns the configured loopback listener. This
transport is therefore not a supported shared-host production boundary. Such
a deployment requires peer-authenticated TLS or a permission-protected Unix
socket; neither transport is implemented by this slice.

## Configuration

Start the service with exactly one absolute configuration path:

```bash
dim-reviewer-web serve /etc/dim/reviewer-web.json
```

Schema 1 has this shape:

```json
{
  "schemaVersion": 1,
  "host": "127.0.0.1",
  "port": 9081,
  "publicOrigin": "https://review.example.internal",
  "reviewerAccountId": "local-reviewer",
  "nativeGit": {
    "baseUrl": "http://127.0.0.1:9080",
    "username": "reviewer-a-user",
    "password": "replace-with-native-random-secret",
    "projectId": "project-a",
    "repositoryIds": ["source"],
    "reviewerId": "reviewer-a"
  },
  "accounts": [{
    "username": "local-reviewer",
    "passwordHash": "scrypt$16384$8$1$BASE64_SALT$BASE64_32_BYTE_HASH"
  }],
  "session": {
    "idleSeconds": 900,
    "absoluteSeconds": 28800
  }
}
```

The supported password-hash parameters are exactly scrypt `N=16384`, `r=8`,
`p=1` with a 32-byte derived key. Generate salts independently for each account.

## HTTP API

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/healthz` | Minimal unauthenticated process liveness only |
| `POST` | `/v1/session` | Verify local credentials and create a session |
| `GET` | `/v1/session` | Return the attested scope and CSRF token |
| `DELETE` | `/v1/session` | Invalidate the current session |
| `GET` | `/v1/projects/:project/repositories/:repository/reviews/:review` | Return a scoped review DTO |
| `POST` | `/v1/projects/:project/repositories/:repository/reviews` | Create review evidence for exact refs |
| `POST` | `/v1/projects/:project/repositories/:repository/reviews/:review/approvals` | Approve the exact review as the attested reviewer |
| `POST` | `/v1/projects/:project/repositories/:repository/reviews/:review/revocations` | Revoke only the attested reviewer's active approval |

All other paths, methods, query strings, encoded path extensions, foreign
Projects, and foreign repositories are rejected. `/healthz` contains no
identity or dependency detail; every `/v1` operation either establishes or
requires authenticated reviewer state.

Only the session whose account ID equals `reviewerAccountId` may call the two
decision routes. Other authenticated accounts receive `403` and receive review
DTOs with `canDecide: false`; the browser therefore renders evidence without
approval or revocation controls. While a decision is in flight, in-page review
navigation and sign-out remain locked until the fresh native result is rendered.
