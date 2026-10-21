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
routes.

The UI lists accounts/routes/models and projects, checks backend authentication
without inference, creates projects, edits routing/limits, pauses or disables
admission, reads usage and request metadata, requests cancellation and revokes
workspace principals. Unknown upstream outcomes remain explicit. Codex sign-in
is performed on the provider authorization page and belongs to that account’s
isolated backend, independently of the DIM Web session. The panel displays the
authorization code and allows checking the connection; multiple accounts may
authorize independently. The corresponding CLI plugin and Web plugin use the
same typed operation API.
