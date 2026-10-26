# DIM console design

The console supports ordinary workspace management and explicitly installed
features. Its purpose is to make the selected target, available authority,
current result and next useful action understandable. It is an operational
interface: use concrete verbs, restrained hierarchy and nearby explanations.
Do not invent metrics or imply authority from a successful login.

## Non-Git task workbench

The 2026-10 rebuild is an operational workbench, not a monitoring dashboard.
Keep the existing self-hosted Geist, dark neutral tonal surfaces, explicit borders,
44px controls and scarce pale-blue action color. Use a compact persistent task
navigation, a readable object header and separated working sections. Document
scroll owns vertical movement; only literal logs and wide tables scroll locally.
On narrow screens navigation wraps and list/detail regions become one column.

The primary user is a developer resuming a persistent workspace; secondary users
inspect execution failures, connect routing accounts or administer console access.
Read-only users must understand blocked actions without being offered authority
they do not have. Status must distinguish runtime, durable data, service readiness
and reachability. Unknown writes remain locked until an explicit authoritative
read; navigation and reload never repeat a write.

Native hash routes keep browser history and new-tab behavior without broadening
the server's static-path or query acceptance: `#/workspaces`,
`#/workspaces/HOST/UUID`, `#/workspaces/HOST/new`,
`#/features/FEATURE/...`, and `#/settings`. Only object identities, selected
sections and filters belong in routes. Secrets and form bodies never do. The
requested hash stays through sign-in, expiry and restoration. Missing destinations
show an explanation and an explicit Workspaces link, never a different authority.
Core owns route syntax and session fencing; each plugin owns its route tail.
The location capability also exposes a non-secret user-intent revision. Async
creation may open its accepted object only when no newer user intent or URL
has superseded that submission; accepted background work never steals a task.

Reusable primitives: native navigation links (default/current/focus), object
headers, workspace list/detail, section navigation, grouped labeled fields,
inline feedback (waiting/empty/denied/stale/unknown/accepted/error), selectable
literal evidence, destructive confirmation and connection recovery. All reuse
the existing token scale. No decorative charts, metrics, heroes or auto-motion.
Forms remain mounted through in-session navigation. No service secret is stored
in browser storage; sign-out clears mounted data. Persist only explicitly safe
workspace creation/resource drafts scoped to the authenticated account where
implemented, and reconcile uncertain state after reload rather than replaying it.

### Capability and ownership outcome map

| Task | Existing owner and supported behavior | Rebuild responsibility |
| --- | --- | --- |
| Workspace | Core operations: configured local/SSH host list, create, start/stop/restart/recreate/discard, CPU/memory/PID updates with UUID guard | Object links, clear persistent-data/runtime distinction, retained forms and reconciliation |
| Tools | agent-tools Web/host plugins: setup, OpenCode status/start/stop, explicit credentials/password, approved URL/client opening | Natural workspace section, running versus reachable status |
| External URLs | external-urls Web/host plugins: list/create/approve/revoke with workspace UUID and ingress catalog | Visible workspace route task, pending/revoked versus usable links, recovery |
| Execution | execution Web/service client: jobs/detail/capacity/cancel/retry, generic installed task handlers | Independent service selection, job URLs, results/logs/artifacts and truthful worker/dependency failures; no arbitrary command launcher |
| LLM routing | llm-router Web/owner service: independent accounts, Codex device flow, compatible API keys, catalog/routes/projects/policy/traffic | Task sections and object URLs with explicit service scope; preserve account and model choices |
| Settings/access | Core session/accounts, installed extension catalog | Capability/connection overview, role/access administration and exact owner guidance |
| Secondary host features | VM/KVM, cache-server/mirrors, tailscale/tunnels are explicit host plugins | Discoverable capability guidance; no invented Web configuration APIs |
| Git | Existing Native Git plugin and domain contracts | Keep existing access only; no Git domain redesign |

### Decision and evidence

Direction independently reviewed by a delegated visual-engineering designer.
Reference: Vercel Web Interface Guidelines for native links, URL state, labeled
forms and inline recovery, adapted to DIM's authority boundaries. Existing
design primitives are retained rather than importing a new framework. Agent
critique is heuristic evidence, not a human usability study. Real provider OAuth,
real remote hosts and privileged VM/cache/network behavior require separate
operator/runtime verification; synthetic browser services cannot establish them.

This document owns interaction and presentation guidance. The
[Web API contract](../../../docs/specs/local-details/web-api.md) owns security
requirements; the [Web plugin guide](../../../docs/guides/web-plugins.md) describes
extension configuration. The [primitive showcase](showcase/index.html) is a
development reference, not a working management console or evidence that the
product implements a demonstrated interaction.

## Ownership and navigation

The core owns session restoration, sign-in, sign-out, host workspace operations,
feature navigation, trusted plugin loading and shared visual primitives. It does
not interpret Native Git review, execution or LLM routing workflows. Each Web
plugin owns its service connection, public operation contracts, domain-specific
panels, forms and result handling. A shared operation descriptor is an authority
and validation contract, not a universal generated form.

Workspaces are the starting view when host operations are configured. A console
with only features opens an available feature instead. Navigation names installed
features directly. An unconfigured feature explains the missing connection; an
unavailable feature offers reconnect without making unrelated features unusable.
Keep target identifiers visible near actions: host/workspace, Project/repository,
job, routing project or provider account as appropriate.

Browser roles are explicit and independent. Read access does not grant mutation;
operator access does not grant human review authority. Present only operations
available to the account and connection, with a useful explanation when access is
missing. Hidden controls are presentation only; server and authoritative service
checks remain mandatory. Installing a panel never grants a service credential. A feature may discover
its connection through trusted host controllers selected by the private Web
configuration; discovery schemas and domain interpretation stay in that plugin.
The core supplies only fixed controller execution with bounded JSON responses.
Host command stdout and stderr each have a finite 32 MiB budget, including JSON
formatting overhead for service responses containing large diffs. A lost,
oversized or invalid command response does not prove a mutation was rejected:
return a sanitized transport failure with unknown outcome and require a state
refresh before retrying, rather than a conflict response.
Explicit manual configuration takes precedence and never silently falls back to
another source of authority.

### Related-object navigation

Use the shared navigation-action primitive for repository, job and routing-project
transitions. It uses a native secondary button, nearby pending/result feedback and
session fencing. Navigation only selects existing data or prefills a creation
draft; it never approves, creates, retries, resolves or publishes on its own.
The destination validates a complete target before changing scope and reports an
unavailable target without falling back to a different controller or object.
Automatic controller provenance may connect Git and execution surfaces; manual
service connections are independent even when their display IDs match.

Mounted destinations register an explicit navigation handler and keep drafts when
hidden. Lazy loading coalesces concurrent mounts; logout invalidates pending
navigation and clears handlers. Managed workspace prefills require an operator and
an exact configured host. Existing edited or outcome-unknown creation drafts stay
intact; replacement is explicit and must not bypass reconciliation. Routing policy
navigation retains the existing unsaved-edit confirmation. Unknown-request usage
correction accepts two observed nonnegative integer counts or neither, never an
estimate presented as observed usage.

## Workspaces and forms

Show workspace names, observed state and common lifecycle actions first. Put
creation in an explicit New workspace form and uncommon runtime/image/resource
settings under advanced options. Group resource edits, recreation and discard
under workspace settings. Discard requires confirmation naming the workspace and
persistent data; cancellation sends no mutation and reports no success.

Each host owns its refresh, name search and state filter. Filtering hides rows
without replacing their DOM, so open settings, focus and drafts survive. A filtered
empty result says that no rows match and offers a clear-filter action; it is not the
same as an empty host. Host refreshes are serialized. A refresh requested after a
mutation always performs a later read instead of sharing an older in-flight read.

Refresh and unrelated actions preserve unfinished creation and resource drafts.
Errors belong beside the affected form, row or host and explain what was kept
and how to retry. One unavailable host does not erase results for other hosts.
Actions on an existing workspace retain its immutable UUID fence even when names
are reused. Do not expose host executable paths or server credentials as fields.

Feature plugins similarly preserve drafts through navigation and reconnect when
scope is unchanged. Explicitly opening another domain object may replace its
form; background list refresh must not do so. A failed write preserves input.
Successful creation clears its identifier only after acceptance. Policy editors
retain the returned revision for subsequent edits instead of reusing an old
compare-and-swap revision.

## Results, failures and independent availability

Separate a mutation receipt from subsequent reads. If a service accepts a create,
save, approval, cancellation, retry, promotion or sync operation and the following
refresh fails, say the action was accepted and identify which read failed. Offer
a refresh of current state; do not label the accepted action as failed or invite
another mutation as its recovery. Retain useful returned evidence and suppress
accidental duplicate submission until the user edits or reloads current state.

When a write response is lost, the outcome may be unknown. Tell the user to check
current state rather than inventing success or rejection. Operations with explicit
idempotency keys, such as execution retry, reuse the same key when retrying that
logical request, including after response loss.

Workspace mutations with a lost response, or an accepted write followed by a
failed workspace read, disable repeat submission and expose Check current state.
A successful explicit check re-enables lifecycle and resource actions. Creation
remains blocked for the same name when that name exists after reconciliation;
finding it does not prove which request created it. Known validation and domain
rejections remain editable and retryable, except a known name conflict stays
blocked until the name changes or a current-state read shows it absent.

Resource fields show the last host-returned limits, mark unsaved edits and provide
a scoped reset. Guidance includes concrete CPU, memory and PID examples plus
`unlimited`. Removing a limit may require host-side runtime replacement while data
is kept; the UI never claims replacement occurred unless host state says so.

Load independent sections independently. Requests and workspace access can show
their own results even when the other query is unavailable. Retain previously
loaded rows with a scoped stale/read-failure explanation. Do not describe an
unavailable query as an empty result. Keep loading, empty, unavailable, denied,
conflict, stale and accepted states distinct in text.

Reconnect reattests the fixed private server connection or rediscovers it through
the same trusted controllers. It cannot select a new
credential path or widen the browser account's roles. A successful reconnect
keeps a mounted feature's drafts and offers its own refresh controls. Failure
remains local to that feature. Sign-out and session expiry dispose session-owned
panels and drafts; late responses cannot populate a later account's screen.

## Visual primitives and accessibility

Reuse [tokens.css](src/assets/tokens.css) and shared controls in
[app.css](src/assets/app.css). Use neutral tonal surfaces and explicit borders,
self-hosted Geist Sans/Mono, a four-pixel spacing rhythm and a scarce primary
action color. Status words carry meaning without relying on color or animation.
Keep operational copy short and specific; avoid decorative dashboard sections.

Use native buttons, labels, forms, headings, tables and definition lists. Every
control needs visible keyboard focus and usable disabled/loading feedback.
Provide nearby status or alert text without announcing whole tables, patches or
logs as live regions. Login errors do not reveal whether an account exists;
an origin mismatch explains the exact configured URL. Successful sign-in clears
the password, and sign-out returns focus to the login controls.

Controls target 44 CSS pixels, body text targets 4.5:1 contrast and focus/control
boundaries target 3:1. Preserve keyboard order, zoom, reduced motion and forced
colors. These are design and verification targets, not a claim of a completed
assistive-technology audit.

At narrow widths and 200% zoom, forms and action groups reflow into a usable
single column. Long IDs and paths wrap without altering their underlying text.
Wide tables, literal patches and logs may scroll inside their own regions;
they must not cause page-level horizontal overflow. Render service content as
text, never interpreted HTML, and keep exact evidence selectable and copyable.

## Verification

Core browser checks cover sign-in/origin guidance, workspace creation and retry,
draft preservation, resource edits, discard cancellation, host recovery and
read-only access. Feature browser checks use the real plugin loader and service
protocols for domain actions, role differences, reconnect, mobile reflow and
accepted-write/read-failure handling. Execution retry additionally exercises
response loss and idempotency-key reuse. Keep these checks with their owning
feature under tests/web; synthetic primitives alone cannot establish product
behavior. Record any manual accessibility or usability evidence separately from
automated coverage, with its tested scope and remaining limitations.
