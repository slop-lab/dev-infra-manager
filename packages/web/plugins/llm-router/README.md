# LLM router Web plugin

Install this package alongside the matching `@slop-lab/dim-web` and add a
private Web configuration entry:

```json
{"plugins":[{"package":"@slop-lab/dim-web-plugin-llm-router","config":{"connectionFile":"/absolute/private/router-operator.json"}}]}
```

The connection and referenced key are caller-owned mode-0600 files. They remain
on the Web server. The router's separately configured operator identity owns
remote authority; browser read/operator roles further restrict access. A feature
selection without `config` displays connection setup status instead of invoking
an unconfigured backend. Provider keys are sent only by an operator to the
router account creation API; they are never returned in account metadata and the
password field is cleared as soon as the write succeeds. The browser never
receives stored provider tokens.

The UI connects multiple independent Codex accounts through device authorization
and accepts separate OpenAI-compatible or Anthropic-compatible API base URLs and
keys. Accounts retain their own credentials; routes select an account and
explicit model mappings. The route editor supports multiple models and changing
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
