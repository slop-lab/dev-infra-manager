# Reviewer Web API

**Kind: Implementation profile**

## Scope

`@slop-lab/dim-web` supplies the separately authenticated backend API for the
first reviewer-web slice. It provides local login, memory-backed browser
sessions, session inspection/logout, Project/repository-scoped native review
inspection, and review-evidence creation. The service ships a same-origin browser
frontend for those operations. Host deployment,
approval/revocation, promotion, CI reporting, host-admin routes, and generic
proxying remain absent.

## Trusted startup and identity binding

Startup consumes one absolute, caller-owned, non-symlink, mode-`0600` regular
JSON file. The service accepts only loopback bind addresses and an explicit
public HTTP(S) origin. Plain HTTP is limited to loopback origins for local
verification; production origins use HTTPS.

The file contains scrypt hashes for local web accounts and one native Git Basic
credential. Before opening its listener, the service calls exact native
`GET /v1/identity` without redirects. Startup succeeds only when the response
is role `reviewer` and its Project ID, ordered repository IDs, and reviewer ID
exactly match configuration. Native `401`, `503`, malformed output, another
role, or any scope mismatch fails before bind.

The browser never receives the native username, password, Authorization header,
or a selectable native URL or operation. Configuration reload is not supported;
changing identity or scope requires restart and fresh attestation.

## Browser authentication and request integrity

Local passwords are verified against fixed-parameter scrypt hashes. One
process-global token bucket admits an initial burst of five derivations and
refills one token per second; at most two admitted derivations run concurrently.
The bucket is not keyed by an attacker-controlled account name, admitted work
is never refunded, and excess work is not queued. Either bound returns `429`
with `Retry-After: 1`. Unknown users and known users with a wrong password both
perform one derivation and constant-time hash comparison, and their login
failures are indistinguishable. A successful login creates independent random
session and CSRF tokens held only in process memory and invalidates every prior
session for that account. The session cookie is opaque, `HttpOnly`,
`SameSite=Strict`, path `/`, and `Secure` whenever `publicOrigin` is HTTPS.

Sessions enforce configured idle and absolute deadlines. Expired sessions are
pruned across the store before login and session creation. The store has a hard
256-session cap; a valid login that cannot replace an account's existing
session and cannot obtain capacity receives `429` with `Retry-After: 1`.
Logout deletes the session, process restart deletes all sessions, and an
expired, rotated, deleted, malformed, or unknown cookie receives `401`. Every
unsafe operation, including login and logout, requires the exact configured
`Origin`; authenticated unsafe operations additionally require the current
synchronizer token in `X-DIM-CSRF`. Origin or CSRF mismatch receives `403`
before native dispatch.

`GET /healthz` is the only unauthenticated liveness route and returns no
identity, configuration, or dependency state. Every `/v1` route either creates
an authenticated session or requires one. Responses use `Cache-Control:
no-store`, a deny-all content security policy, no-referrer policy, content-type
nosniff, and framing denial.

## Fixed review surface and browser DTO

The service accepts only these native-backed routes:

- `GET /v1/projects/PROJECT/repositories/REPOSITORY/reviews/REVIEW_ID`
- `POST /v1/projects/PROJECT/repositories/REPOSITORY/reviews`

The path Project and repository must be present in the startup-attested scope.
Foreign and malformed paths return `404` without native dispatch. Query strings,
encoded suffixes, review action suffixes, arbitrary URLs, and arbitrary methods
are absent.

The POST body contains only `protectedRef` and `proposalRef`, is size-bounded,
and is protected by session, exact Origin, and CSRF checks. This operation
creates immutable review evidence; it does not approve, promote, merge, or
update a protected ref.

Native review responses are parsed and projected into an explicit browser DTO.
The DTO includes immutable IDs/refs/revisions, printable changed paths and
symlink targets, object IDs and modes, printable patch text, required reviewer
IDs, safe approval/revocation timestamps, and safe terminal job summaries. It
omits `patchBytes`, raw path bytes, policy digest, writer username, reviewer
username, revoker username, reporter username, native credentials, and every
unknown native field. Patch and path strings remain untrusted JSON data and
must be rendered as text, never HTML.

## Bounds and verification

Configuration, browser request bodies, native responses, native request time,
HTTP headers, HTTP request time, keep-alive lifetime, and requests per socket
are bounded. Password derivation concurrency and total in-memory sessions are
also bounded. The native client performs no redirect following.

The configured loopback HTTP native transport does not authenticate the native
server as a network peer: the Basic credential authenticates this client to the
process that owns the listener. It is not a shared-host production boundary.
Shared-host deployment requires peer-authenticated TLS or a
permission-protected Unix socket, neither of which this implementation profile
provides.

Paired development tests use the real `nativeGitReviewFixture`, real disposable
Git repositories, and real localhost servers. They cover mode and symlink
configuration rejection; wrong native credentials, role, Project, repository
set, and reviewer identity; login failure; cookie flags; idle and absolute
expiry; CSRF, Origin, logout replay, foreign Project/repository, tampered path,
and generic proxy denial; safe review creation; and omission of native secret
and raw-byte fields. They also cover concurrent and sequential derivation
saturation, one-token refill, recovery, unknown-account equivalent work,
account session rotation, logout after rotation, expired-orphan pruning, and
hard session capacity.
