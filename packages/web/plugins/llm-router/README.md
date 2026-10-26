# LLM router Web plugin

Install this package alongside the matching `@slop-lab/dim-web`. With a
package-only Web entry, the plugin discovers router connections through the
configured local and SSH controllers:

```json
{"plugins":[{"package":"@slop-lab/dim-web-plugin-llm-router"}]}
```

On each trusted controller, `dim llm-router connect --connection FILE` selects
its private operator connection. **Router controller** selects which service to
inspect or manage. Discovery isolates unavailable controllers; operations bind
to the selected connection fingerprint. Changing that private selection requires
reconnecting the feature before new operations. The router can run on the control
plane or another reachable machine; it need not run beside Web or the workspace.
Web forwards typed operations through the controller and never supplies an
operator file path, provider credential or connection override.

An explicit private Web connection remains available and takes precedence over
automatic controller discovery. This direct connection is also pinned until
feature reconnection, so editing its file cannot silently redirect a live panel:

```json
{"plugins":[{"package":"@slop-lab/dim-web-plugin-llm-router","config":{"connectionFile":"/absolute/private/router-operator.json"}}]}
```

The connection and referenced key are caller-owned mode-0600 files on the trusted
server. The router's configured operator identity owns remote authority; browser
read/operator roles further restrict access. Provider keys are sent only by an
operator to the router account creation API, never returned in account metadata,
and cleared from the password field after a successful write. Stored provider
tokens never reach the browser.

The workbench uses native hash links for its task and object state. A private
direct connection uses `#/features/llm-router/accounts`,
`accounts/ACCOUNT`, `projects`, `projects/PROJECT`, and `traffic`. Discovered
connections always insert the controller key after the task name, for
example `projects/CONTROLLER/PROJECT`. This keeps reload, Back/Forward and new-tab
behavior bound to the exact discovered authority instead of guessing from a
matching account or Project ID, even when only one controller is ready. Missing,
unknown or unavailable explicit controllers never fall back to another service.
Invalid task paths explain the problem without rewriting the URL; a missing
object stays missing and explains the unavailable target rather than selecting a
different account, Project or controller.

Accounts & routes owns provider discovery, Codex device authorization, compatible
API credentials, model inspection and explicit route mapping. Projects & policy
owns admission state, usage allowance and revision-fenced policy editing. Traffic
& access owns request outcomes, observed-usage reconciliation and workspace
principal revocation. All three sections remain mounted while navigating so safe
drafts and accepted/unknown-outcome locks survive browser history changes. A
blocked dirty-policy navigation restores the prior canonical Project URL.
Late project creation and account rename results preserve newer edits to the
same form. Reconciliation of an older rename also retains the newer display-name
draft rather than replacing it with the previously submitted value.

After reconciling a lost policy response, **Reload project** reads the current
project revision before a separate edit. Editing the retained form does not unlock
another save against its older compare-and-swap revision; unsaved policy replacement
still requires confirmation. A reconciled generated Codex account creation offers **Connect another
Codex account** as an explicit new intent, not a retry of the interrupted request.

Switching controllers asks before discarding unsaved policy, route or account
forms. Cancelling preserves the selected controller and fields. A policy save
must finish before switching; late responses from a previous controller cannot
replace the new controller's panel. Request and workspace links carry the exact
router controller and project identity. Every discovered-router
navigation target must include `controllerKey`; matching
project IDs do not establish a connection between those routers.

Controller switching and controller rediscovery are blocked while any owner write
has an unknown outcome. **Refresh router** reconciles writes covered by current
owner metadata. An unknown provider sign-in start cannot be recovered from the
account catalog until the account becomes connected, so the mounted session keeps
that lock and directs the user to the router operator; ending the Web session may
clear the UI lock without claiming that the backend login was cancelled.

The UI connects multiple independent Codex accounts through device authorization
and accepts separate OpenAI-compatible or Anthropic-compatible API base URLs and
keys. Accounts retain their own credentials; routes select an account and
explicit model mappings. **Inspect account models** can add discovered models, including their API and
context/output metadata, directly to a route draft. Connected Codex accounts
offer **Sign in again** for credential renewal. The route editor supports multiple models and changing
the account without replacing its credentials. Account selection remains
explicit; usage-based automatic account routing is a future policy. Read-only
users can inspect accounts but cannot create accounts, start sign-in, or save
routes. **Connect Codex account** starts sign-in directly: no account ID or label
is required. The router creates an internal ID and the authenticated email becomes
the default display name. API connections also generate IDs automatically and
accept an optional label. Rename an account later without changing its credentials,
routes or recorded usage.

The UI lists accounts/routes/models and projects, checks backend authentication
without inference, creates projects, edits routing/limits, pauses or disables
admission, reads usage and request metadata, requests cancellation and revokes
workspace principals. Unknown upstream outcomes remain explicit. Codex sign-in
is performed on the provider authorization page and belongs to that account’s
isolated backend, independently of the DIM Web session. The panel displays the
authorization code and checks completion automatically; multiple accounts may
authorize independently. The corresponding CLI plugin and Web plugin use the
same typed operation API.

Request and workspace-principal rows link to their exact routing project through
the shared Web navigation action. The destination accepts only a routing-project
target that exists in the router's loaded project catalog. Opening the current
project focuses its policy without replacing an unsaved draft; opening another
project keeps the existing dirty-policy confirmation, and cancellation leaves the
current selection unchanged. Router project IDs are not interpreted as Native Git
projects, workspace hosts or any other provider identity.

An operator resolving an indeterminate request may enter both observed input and
output token counts as nonnegative integers, or leave both blank to retain unknown
usage. Partial or invalid accounting remains in a request-scoped draft and sends
no operation. Drafts survive router refresh and feature navigation. A failed
resolution preserves the fields for retry. A response with an unknown outcome
locks that exact request and keeps its draft until an explicit successful
**Refresh router** reads authoritative request state. If the request is still
unresolved, the draft reopens for retry; if the router already accepted it, the
UI does not resend the mutation. Known service rejections remain immediately
editable and retryable. Once the router accepts a resolution, the draft is
cleared and repeat mutation is blocked even when the subsequent request-list
refresh fails; the UI reports the accepted resolution separately from that read
failure.

Resolving execution uncertainty without usage releases occupancy but retains
accounting reconciliation. The finished request then offers **Record observed
usage**, requiring both nonnegative counts and calling the same audited
`request.resolve` operation without replaying inference. Read-only sessions show
request metadata without resolution fields or mutation controls.

All other router-owner mutations use the same transport distinction. A known
service rejection keeps the relevant draft editable. An accepted write remains
accepted when a following read fails. A transport-unknown create, rename, route,
project, policy, state, cancellation or principal write keeps its draft and locks
repeat submission until a successful authoritative owner read that started after
the unknown outcome. Reads already in flight before the failure cannot release a
newer lock. The later read either shows the intended state and keeps the mutation
accepted, or shows that it was not applied and permits an explicit retry.

Account creation submits an internally generated UUID through the owner's
existing optional account-ID field; users do not enter IDs. Reconciliation matches
that exact ID and provider, never another actor's newly listed account. An absent
current read permits an explicit retry with the same intent UUID, not a second
generated account identity. Because the owner
API has no device-session listing operation, an unknown `account.login.start`
cannot be proven absent while the account remains unconnected; that sign-in action
stays locked for the mounted session rather than starting another backend login.
Account creation remains unavailable until a successful current account-catalog
read establishes readiness. Out-of-order account reads cannot
replace a newer catalog, and an account returned by a successful create is included
in the retained catalog even when its immediate follow-up list read fails.
An accepted or reconciled API connection clears its submitted key when that key
is still present; a newer key draft is retained. Late route acceptance likewise
preserves and unlocks a newer route draft after the older outcome is settled.
