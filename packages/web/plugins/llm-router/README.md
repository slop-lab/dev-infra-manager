# LLM router Web plugin

Install this package alongside the matching `@slop-lab/dim-web` and add a private
Web configuration entry:

```json
{"plugins":[{"package":"@slop-lab/dim-web-plugin-llm-router","config":{"connectionFile":"/absolute/private/router-operator.json"}}]}
```

The connection and referenced key are caller-owned mode-0600 files. They remain
on the Web server. The router's separately configured operator identity owns
remote authority; browser read/operator roles further restrict access. A feature
selection without `config` displays connection setup status instead of invoking
an unconfigured backend. This plugin never reads or exposes provider tokens.

The UI lists accounts/routes/models and projects, checks backend authentication
without inference, creates projects, edits routing/limits, pauses or disables
admission, reads usage and request metadata, requests cancellation and revokes
workspace principals. Unknown upstream outcomes remain explicit. Provider sign-in
belongs to the pinned backend, not to this Web application's browser session.
The corresponding CLI plugin and Web plugin use the same typed operation API.
