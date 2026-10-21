# Web console API

**Kind: Implementation profile**

## Scope and ownership

`@slop-lab/dim-web` supplies optional authenticated console infrastructure and
ordinary local/SSH workspace operations. Feature packages own their service
connections, operation declarations and browser panels. Native Git, execution
and LLM routing are explicitly installed Web plugins. The console has no
required control-plane service, Native Git credentials or CI implementation.

The trusted Web server selects directly installed package names in its private
configuration. Merely discovering a host/service capability never loads new
browser code. Selected plugins execute with Web-server authority and must be
reviewed like the server itself; they are not isolated or untrusted plugins.
The selected runtime must contain each package directly; Node's ancestor
module lookup cannot borrow a package from another runtime.
Repositories and browser requests cannot select plugin modules, executable
paths, operator connection files or upstream URLs.

## Trusted startup

Startup consumes one absolute, caller-owned, non-symlink, single-link,
mode-0600 regular JSON file. Listener addresses are loopback only; public origins
are exact HTTPS or loopback HTTP origins without credentials or paths.

Configuration contains hashed local accounts with explicit read, operator and
reviewer roles; optional ordinary host operations; a plugin runtime path; and
explicit plugin selections `{package,config?}`. No role implies another. A
selection without config may use the selected plugin's optional controller
adapter. Without that adapter or configured controllers it is unconfigured and
makes no service calls. Configured plugins validate private connections during
startup, before
binding. An unavailable backend leaves that feature unavailable while unrelated
features and workspaces remain usable. Invalid installed module declarations
still reject startup. A failed feature cannot perform actions or silently connect
to another service. Configuration changes require restart. An authenticated,
CSRF-protected reconnect retries only the original private configuration and
must attest it again before exposing operations. Automatic connections rediscover
through the same fixed controllers; explicit configuration never falls back to
discovery after a failure.

`dim-web init-operations SETTINGS --output CONFIG` initializes ordinary hosts
without contacting a control plane. `dim-web init-features SPEC --output CONFIG
--roles ROLES` requires an explicit comma-separated role selection and validates
configured plugins before writing. Both initialize a fresh browser password,
store only its scrypt hash, write mode-0600 files and refuse overwrite.

## Trusted controller capability

The core builds a readonly `WebPluginContext.controllers` list from private
host settings. Each entry exposes an ID and a JSON-returning `run(args)` method.
Only the reviewed server-side plugin receives it. Executable and host selector
are fixed; the invocation is `[--host, SELECTOR, ...ARGS, --json]` without a shell.
Arguments are bounded to 128 entries, 4,096 characters each and 32 KiB UTF-8 total;
NUL and `--host`/`--json` overrides are rejected. Output is bounded to 2 MiB and
execution to 30 seconds by default. A trusted plugin may request a positive
integral deadline up to 180 seconds; the browser operation transport separately
permits an explicit deadline up to 185 seconds (35 seconds by default). Invalid
or unknown timeout options reject before dispatch. Errors do not include subprocess output or credentials.

Plugins own optional `autoConnect(context)`, their discovery commands and all
feature-specific schemas, connection validation and scope. The core supplies no
Native Git, Project or repository interpretation. Automatic selections count as
configured, remain unavailable when discovery fails and rediscover on reconnect.
Manual `create(config)` always takes precedence. Neither path widens browser
roles or exposes generic controller execution through a browser endpoint.

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
before feature dispatch.

`GET /healthz` is the only unauthenticated liveness route and returns no
identity, configuration, or dependency state. Every `/v1` route either creates
an authenticated session or requires one. Responses use `Cache-Control:
no-store`, a deny-all content security policy, no-referrer policy, content-type
nosniff, and framing denial.

## Plugin operation and asset boundary

`GET /v1/extensions` returns installed feature descriptions, configuration status,
and only operations allowed by the current account roles. Each operation has a
unique declared name, access role, strict input parser and bounded public output
parser. `POST /v1/extensions/ID/operations/NAME` requires an authenticated session,
exact Origin, CSRF and the declared role before invoking a configured handler.
`POST /v1/extensions/ID/reconnect` also requires exact Origin and CSRF. It accepts
only an empty body, never a new connection or credential path, and grants no
operation authority. Undeclared methods and operations cannot dispatch. A plugin runtime may expose
a subset of declared operations, for example when no promoter is configured.

Declared browser assets are fixed reviewed file URLs, bounded in size and
served only to authenticated sessions. The server rejects undeclared paths,
unsafe asset names, invalid module declarations, duplicate IDs/packages, unsafe
links and non-files. Browser entry modules use the shared authenticated request
transport; the console does not expose arbitrary command execution or an HTTP
proxy. Inputs, handler results and public errors cannot include raw service
credentials. Feature browser code renders untrusted results as text, never HTML.

All operation POSTs require CSRF, including read operations sent using POST.
Requests and handler responses are bounded; a backend error is sanitized.
Feature UI pending operations cannot populate a later account's view, and
sign-out clears mounted panels, drafts and session-owned content.

## Workspace operations

Authenticated status exposes only configured host IDs and credential-free
console URLs. Host IDs map to trusted server-side DIM executables and existing
host selectors. GET workspace lists project only immutable ID, name, runtime,
phase, observed runtime status and resource limits. POST creation accepts safe
Git source input and explicit runtime/resource selection. POST lifecycle actions
allow only start, stop, restart, recreate, discard and resources; each requires
operator role, Origin/CSRF and an expected workspace UUID. The adapter invokes
the public CLI without a shell and with separate arguments. The host verifies
the UUID under its lifecycle lock before mutation. Executable paths, state
locations and host selectors never come from the browser. Subprocess time and
output are bounded. Unsafe inputs fail before dispatch.

## Feature authority

The Native Git Web plugin owns controller, Project and repository selection.
Automatic connections use the controller's Native Git plugin to discover its
current local project catalog and ready repositories. Role credentials stay on
the controller; the Web server receives public metadata and validated results.
Every invocation supplies the attested generation and the controller rejects
selection changes before dispatch. Catalog refresh cannot adopt a replacement
generation; explicit reconnect is required. Each request rechecks current catalog
membership, including import-receipt generation, before service access.
Controller-owned project creation and public repository import require the
browser operator role and distinct attested registrar/importer credentials.
These operations are absent from a direct reviewer-only connection. Import
accepts a public HTTPS URL and optional branch, never local paths, credential
paths, executable names or arbitrary policy declarations. The host fetches bare
Git objects through its bounded public transport without executing candidate
code or trusting the remote `.dim` policy. Its own default policy requires review
of subsequent `.dim/` changes. The first imported repository supplies project
defaults; later imports preserve those choices. Retried imports must match their
original URL/branch intent and reuse the pinned draft and receipt.

Manual configuration instead provides an explicit project/repository allowlist,
private reviewer connection and optional separate promoter/sync connections.
It attests exact reviewer role/identity and generation, plus promoter
endpoint/generation when selected. Business requests pin that generation.
Review IDs always include controller, Project and repository scope, never inferred
alone. The browser fences delayed responses and keeps drafts per complete scope.
The service independently checks required-reviewer authority, approval ownership,
stale evidence and protected promotion compare-and-swap. Browser reviewer role
and operator promotion role remain distinct. Read-only accounts have no decision
operation. The plugin's public DTO omits credentials and unknown raw fields,
projects literal patch/path data and canonical immutable inputs, and bounds text.

Execution Web features use the standalone execution client, a private query
connection and optional distinct operator connection. Query-only accounts cannot
cancel or retry jobs. Browser mutation requires operator role as well as service
credentials. Retry retains its explicit UUID idempotency key. Worker occupancy
describes configured capacity, not heartbeat liveness. Diagnostics retain bounded
prefixes and truncation markers and never expose grants or worker leases.

The LLM router Web feature and its CLI plugin use the same operation/client
contracts. Service-side actor credentials and browser roles independently bound
authority. Provider credentials, router keys, prompt/response captures and
internal raw records are not public operation results.

## Verification and resource priority

Core tests exercise private configuration, exact origins, cookie hardening,
logout replay, bounded password work, session rotation and monotonic expiry,
CSP, workspace role/CSRF/UUID checks and separate CLI arguments without starting
a control plane. Feature tests use real disposable services and repositories
for attestation, repository scoping, generation replacement, approvals and
execution operations. Browser regressions exercise the real plugin loader and
independent workspace flows; no compatibility routes exist for old built-ins.

Development containers and execution supervisors have positive OOM victim
adjustment. An administrator-installed Web system service may set
OOMScoreAdjust=-500 with explicit memory/CPU/task bounds. An unprivileged process
must not be assumed able to lower its own OOM score. Repository install-local
may explicitly configure the documented loopback user service.
