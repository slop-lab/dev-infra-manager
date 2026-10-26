# Web console API

**Kind: Implementation profile**

## Scope and ownership

`@slop-lab/dim-web` supplies optional authenticated console infrastructure and
ordinary local/SSH workspace operations. Feature packages own their service
connections, operation declarations and browser panels. Native Git, execution,
workspace tools, external routes and LLM routing are explicitly installed Web plugins. The console has no
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

Configuration contains hashed local accounts with explicit read, operator,
reviewer and account-admin roles; optional ordinary host operations; a plugin runtime path; and
explicit plugin selections `{package,config?}`. No role implies another. A
selection without config may use the selected plugin's optional controller
adapter. Without that adapter or configured controllers it is unconfigured and
makes no service calls. Configured plugins validate private connections during
startup, before
binding. An unavailable backend leaves that feature unavailable while unrelated
features and workspaces remain usable. Invalid installed module declarations
still reject startup. A failed feature cannot perform actions or silently connect
to another service. Configuration changes outside the account API require restart. An authenticated,
CSRF-protected reconnect retries only the original private configuration and
must attest it again before exposing operations. Automatic connections rediscover
through the same fixed controllers; explicit configuration never falls back to
discovery after a failure.

`dim-web init-operations SETTINGS --output CONFIG` initializes ordinary hosts
without contacting a control plane, with read/operator/account-admin authority
for its initial account. `dim-web init-features SPEC --output CONFIG
--roles ROLES` requires an explicit comma-separated role selection and validates
configured plugins before writing. Both initialize a fresh browser password,
store only its scrypt hash, write mode-0600 files and refuse overwrite.

## Browser account administration

`GET /v1/accounts` requires `account-admin` and returns usernames and roles only.
`POST /v1/accounts` requires that role, exact Origin, CSRF and the administrator's
`currentPassword`, verified by the same bounded authenticator as login. Its strict
body selects `add`, `set-roles`, `reset-password` or `remove`, a username, and roles
only for add/set-roles. No ordinary operator or reviewer may self-grant account
administration. Existing installations retain their chosen roles; trusted OS-owner
CLI configuration provides bootstrap/recovery.

The writer rechecks the actor against current private configuration under its
account lock before committing. It preserves other configuration, rejects removal
of the last account or the last administrator, enforces the loader's serialized
size limit, and atomically replaces the private file. Web writes replace the live
account snapshot and authenticator without changing plugin connections. Role
changes, resets and removals invalidate the target's sessions, including the
caller's own when applicable. A login in flight against a replaced snapshot may
not recreate a revoked session. The API returns only public accounts, the affected
username, an optional generated password shown once, and `signInRequired`.
No password hash, config path or raw host/service credential is returned by this API.
An update rejected before commit may return a bounded conflict explanation;
unknown errors do not expose filesystem or service diagnostics. Independent
editors/install-local do not share the account writer lock and must not write the
configuration concurrently.

## Trusted controller capability

The core builds a readonly `WebPluginContext.controllers` list from private
host settings. Each entry exposes an ID and a JSON-returning `run(args)` method.
Only the reviewed server-side plugin receives it. Executable and host selector
are fixed; the invocation is `[--host, SELECTOR, ...ARGS, --json]` without a shell.
Arguments are bounded to 128 entries, 96 KiB UTF-8 each and 128 KiB UTF-8 total;
NUL and `--host`/`--json` overrides are rejected. Output is bounded to 2 MiB and
execution to 30 seconds by default. A trusted plugin may request a positive
integral deadline up to 180 seconds; the browser operation transport separately
permits an explicit deadline up to 185 seconds (35 seconds by default). Invalid
or unknown command options reject before dispatch. An optional `input` string is
bounded to 128 KiB UTF-8 and sent through stdin, never command arguments. The
core closes stdin even when no input is provided. Errors do not include subprocess output or credentials.

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
and only operations allowed by the current account roles. Each feature entry has
a server-owned catalog `generation`. Browser operation requests send that value in
`X-DIM-Plugin-Generation`; stale catalogs receive `409` before dispatch. Reconnect
advances the generation before attestation and blocks dispatch while pending.
An invocation whose runtime is superseded while awaiting a result receives an
unknown-outcome `503`, even when another tab initiated reconnect. Direct API
callers may omit the header to select the current runtime at dispatch, but still
receive the same post-await generation fence. Each operation has a
unique declared name, access role, strict input parser and bounded public output
parser. `POST /v1/extensions/ID/operations/NAME` requires an authenticated session,
exact Origin, CSRF and the declared role before invoking a configured handler.
`POST /v1/extensions/ID/reconnect` additionally requires browser `operator`
authority, exact Origin and CSRF. Readers cannot replace the shared runtime or
interrupt pending operator calls. It accepts
only an empty body, never a new connection or credential path, and grants no
operation authority. Undeclared methods and operations cannot dispatch. A plugin runtime may expose
a subset of declared operations, for example when no promoter is configured.

Declared browser assets are fixed reviewed file URLs, bounded in size and
served only to authenticated sessions. The server rejects undeclared paths,
unsafe asset names, invalid module declarations, duplicate IDs/packages, unsafe
links and non-files. Browser entry modules use the shared authenticated request
transport; the console does not expose arbitrary command execution or an HTTP
proxy. Host/control-plane credentials and public errors never expose raw service
capabilities. A plugin may declare a separate operator-only operation to read or
change workspace application credentials. Those secrets stay out of ordinary
status results and command arguments; credential reads happen only on an explicit
operator action. Feature browser code renders untrusted results as text, never HTML.

All operation POSTs require CSRF, including read operations sent using POST.
JSON request bodies are bounded to 128 KiB UTF-8, including their encoded
envelope. Handler responses are bounded; a backend error is sanitized.
Feature UI pending operations cannot populate a later account's view, and
sign-out clears mounted panels, drafts and session-owned content.

The browser core owns one session-scoped navigation broker. Installed navigation
features register one strict target handler through `onNavigate`; the method
returns a handler disposer while plugin `mount` retains its existing optional
mount-disposer return shape. Lazy mounts are coalesced. A newer navigation request,
logout, session replacement or destination disposal fences older completion
before its target handler can run or its result can update caller feedback.
The handler receives a request-current predicate and rechecks it after awaited
reads before changing domain selection. Context-owned navigation capabilities
also reject new calls after their originating session or workspace is disposed.
Navigation performs no generic operation invoke and does not fall back to another
feature, controller, Project, repository or host. Outcomes are explicit
`opened`, `blocked`, or `unavailable` results, with unavailable codes distinguishing
installation, readiness, authority, target validation, target availability,
load failure and ended sessions. The shared navigation-action control renders a
native secondary button with scoped pending, disabled and result feedback.

Git/execution cross-feature targets carry automatic controller provenance plus
complete project/repository or job identity. Manual connections do not acquire
that provenance from matching display IDs. Routing-project targets refer only to
the selected router's catalog and do not imply a managed Git project or host.
Observed unknown-request resolution accepts both safe nonnegative token counts
or no usage; it remains the existing explicit operator operation and never replays
inference. An unknown correction response retains its draft and blocks repeat
submission until an explicit authoritative read started after that lock reconciles
the same request. An older in-flight read cannot unlock a newer unknown outcome.
Finished requests with unresolved accounting can subsequently record both observed
counts, without re-resolving execution or inventing zero usage. Navigation itself
grants none of these mutation roles.

### Browser task locations

Native hash links encode task/object identity without changing accepted HTTP
paths or adding server query parameters. Core owns `#/workspaces`,
`#/workspaces/HOST/UUID[/TASK]`, `#/workspaces/HOST/new` and `#/settings`.
Plugin task locations live below `#/features/FEATURE`. `WebPluginLocation` is an
optional session-scoped browser capability exposing the owner's tail, native
link creation, navigation and a disposable subscription. It carries no operation
authority. URLs never contain service credentials, form bodies or mutation
receipts. Scope changes and session disposal fence URL callbacks just as they
fence operation results.
Its `revision` identifies newer browser navigation intent. Owners fence delayed
related-object reads against that revision before changing selection or location;
accepted background writes must not replace a newer user destination.

Login/session restoration retain the requested task location. The shell must not
fall back from an explicit missing destination to another host or service.
Discovered service object links retain controller provenance independently of
availability. Plugins validate owner-specific tails; hidden lazy mounts may read
their catalog but do not rewrite the visible location before a navigation target
is accepted. Navigation and reload never submit or retry domain writes. Forms
remain mounted through same-session navigation; no secret-bearing drafts are
serialized into browser storage, and session end clears mounted content.

Workspace feature mounts belong to the immutable workspace UUID and session,
not to its mutable runtime phase. The optional `onWorkspaceChange` subscription
notifies the owner when the current `workspace.phase` changes without discarding
drafts or unknown-write locks. A phase transition fences in-flight operation
results; owners reconcile fresh state explicitly before re-enabling stale runtime
controls. Replacing the UUID or ending the session still disposes the entire mount.
Reconnect suspends the feature transport and advances its connection generation.
Replies from an earlier generation cannot populate the reconnected view or unlock
uncertain writes. Failed workspace mounts may retry without disposing healthy
sibling mounts or their drafts.

Same-origin browser tabs coordinate identity changes through the non-secret
`dim.browser-session.epoch` local-storage marker, never serialized credentials or
drafts. A cookie-changing login fences prior views even if its response body is
lost or malformed. Delayed credential actions recheck identity before publishing
their result. A self-account update may retain its one-time receipt only until
the user continues or a later identity change supersedes it. Server handlers
recheck session currency after awaited work before returning protected results.

## Workspace operations

Authenticated status exposes only configured host IDs and credential-free
console URLs. Host IDs map to trusted server-side DIM executables and existing
host selectors. GET workspace lists project only immutable ID, name, runtime,
phase, observed runtime status, initialization status and resource limits. Failed
workspaces may include a fixed public failure category, never raw saved errors.
POST creation accepts safe
Git source input and explicit runtime/resource selection. POST lifecycle actions
allow only start, stop, restart, recreate, discard and resources; each requires
operator role, Origin/CSRF and an expected workspace UUID. The adapter invokes
the public CLI without a shell and with separate arguments. The host verifies
the UUID under its lifecycle lock before mutation. Executable paths, state
locations and host selectors never come from the browser. Subprocess time and
output are bounded. Unsafe inputs fail before dispatch.
Host failures return only reviewed messages and public categories for missing
images, unavailable runtimes/hosts, duplicate names, unavailable projects/refs,
repository access, timeouts or an unknown host failure. Raw subprocess output,
credentials and private paths never cross this boundary. The browser maps those
categories to fixed recovery text and retains submitted input. An uninitialized
workspace cannot be offered Start or Recreate; its existing explicit discard
confirmation remains required before deletion.

Managed workspace navigation is a browser-only prefill, never a create request.
It requires both ordinary operations and the operator role, accepts exactly a
configured `hostId`, `projectId`, nonempty unique `repositoryIds` and a
`workingRepositoryId` contained in that selection, then opens the existing host
creation form with `dim://PROJECT`, repository selection, working repository and
the default container runtime. It sends no request until the user submits the
ordinary form. A pristine form may be populated directly. An edited draft is
preserved and requires the explicit replacement control. A pending request or
an outcome-unknown/accepted-without-readable-state draft cannot be replaced until
the existing current-state reconciliation succeeds. Read-only sessions cannot
open or replace a managed creation draft.

## Feature authority

The Native Git Web plugin owns controller, Project and repository selection.
Automatic connections use the controller's Native Git plugin to discover its
current local project catalog and ready repositories. Role credentials stay on
the controller; the Web server receives public metadata and validated results.
Every invocation supplies the attested generation and the controller rejects
selection changes before dispatch. Catalog refresh cannot adopt a replacement
generation; explicit reconnect is required. Each request rechecks current catalog
membership and live readiness before service access; immutable historical import
generations remain intact across a valid serving-generation update.

The Native Git plugin also exposes authenticated existing-Project discovery and
explicit host attachment through `projects.discover`, `projects.inspect` and
`projects.attach`. The first two return only Project/repository IDs, counts and
managed branch metadata. Attachment requires the browser operator role and
selects both configuration and default working repositories. The controller
fetches its own authoritative evidence and rechecks current workspace authority;
the browser cannot supply receipts, policies, owners, endpoints or credentials.
Attachment writes host-local selections, never repositories, protected refs or
workspace data. Existing choices are not implicitly replaced. A successful
attachment refreshes the local selector; subsequent workspace navigation remains
an explicit draft, not automatic creation. These operations require automatic
controller provenance and are unavailable to direct reviewer-only connections.

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
Without explicit Web configuration, the execution-worker host plugin discovers
these roles beside the selected control-plane connection. It validates private
files and matching generation/endpoint, then attests the query and any operator
role before advertising operations. The Web plugin selects a fixed configured
controller and pins every invocation to its discovered generation. Controller
switches fence pending reads, job actions and retry keys; browser roles continue
to bound authority independently. Connection paths, credentials and arbitrary
host commands are never browser inputs or results.

The LLM router Web feature and its CLI plugin use the same operation/client
contracts. Service-side actor credentials and browser roles independently bound
authority. Provider credentials, router keys, prompt/response captures and
internal raw records are not public operation results.
Account enrollment and route changes require both browser and service operator
authority. Codex authorization returns a bounded device challenge and account-bound
session status; the service never borrows host Codex credentials. API keys are
write-only inputs, retained in private per-account backend partitions and cleared
from successful Web forms. The operator cannot supply a backend executable or
credential path through Web operations. A server-owned pinned executable serves
one credential partition per account. Accounts and model routes are independent;
each inference reserves its selected account and route snapshot for attribution.
Later route edits affect new requests, without rewriting historical usage or
retrying an already dispatched request on another account.

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
