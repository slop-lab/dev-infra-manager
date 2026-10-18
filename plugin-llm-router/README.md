# Host LLM router

Optional, base-workspace-only plugin for issue #51. Install it explicitly with
`dim installer install plugin @slop-lab/dim-plugin-llm-router@0.10.0`.
It adds `dim llm`; it does not install managed Git, a controller, or a backend.

The trusted host process owns provider access, request admission, a SQLite usage
ledger, and private request/response captures. A workspace receives a random
route-scoped token bound to its actual DIM workspace UUID. It never receives the
backend key, provider key, OAuth tokens, account directory, or host sockets.

## Backend and ChatGPT subscriptions

Use an existing reviewed CLIProxyAPI **v8.0.33** instance, bound to loopback, or an
operator-controlled HTTPS endpoint. Supply its client access key in an owned
mode-0600 file. The backend is intentionally a separately operated dependency;
DIM neither downloads an unverified binary nor logs in to an account implicitly.

CLIProxyAPI owns OAuth login and token refresh. Its tagged source implements
`-config /absolute/config.yaml -codex-login` and `-codex-device-login` for a
host-side operator login. Keep `oauth.auth-dir` under an owned private host
folder. For an account-specific route, use a dedicated backend instance/auth
directory containing only the permitted account; aliases are not account
permissions. Disable backend retries and do not configure a paid-provider
fallback. DIM makes one backend call; a backend that retries independently has
multiple opaque provider attempts and is not an attempt-audited route.

OpenAI also documents eligible ChatGPT plan inference through Sign in with
ChatGPT: an issued OAuth client and `chatgpt.tokens.use.direct` permission are
required. A subscription alone does not establish entitlement for every model
or request. This plugin does not copy Codex credentials or impersonate a first
party client. A real authenticated backend inference is the acceptance check;
unit tests with a local backend do not prove subscription access.

Reviewed primary references:

- [CLIProxyAPI v8.0.33 login flags](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.33/cmd/server/main.go)
- [CLIProxyAPI configuration](https://help.router-for.me/configuration/options)
- [OpenAI registration and scopes](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI plan inference limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [OpenCode custom providers](https://opencode.ai/docs/providers/)
- [OpenCode local plugins](https://opencode.ai/docs/plugins/)

## Prepare and run

After the operator's backend login and a real inference have succeeded:

```bash
dim llm prepare /home/operator/.config/dim/llm \
  --backend http://127.0.0.1:8317 \
  --backend-key-file /home/operator/.config/cliproxy/router-access.key \
  --model YOUR_REVIEWED_MODEL --context-tokens 128000 --output-tokens 16384 \
  --listen-host 0.0.0.0 --port 8318
# Review router.json, its model metadata and limits.
dim llm serve /home/operator/.config/dim/llm/router.json
```

Model names and context/output limits above are operator-reviewed inputs, not an
entitlement claim or a built-in universal model profile. `--api chat` selects
Chat Completions instead of Responses. Add explicitly reviewed routes/models in
`router.json` before restarting the service. Existing setup directories are
never replaced. Start this long-running command through your host service
manager if persistence across logouts is needed; its lifetime is independent of
workspace create/recreate/discard.

The default listener is loopback. To reach it from isolated containers, choose a
specific host bridge IP (preferred) or an explicit all-interface bind, and apply
your host firewall. The listener exposes only the scoped inference, model and
usage API, never account login, backend management or configuration writes.
Remote untrusted networks require HTTPS termination. Upstream HTTP is allowed
only on loopback. Transport reachability never grants model access by itself.

## Attach a workspace and use OpenCode

```bash
dim llm attach my-workspace --config /home/operator/.config/dim/llm/router.json \
  --endpoint http://WORKSPACE_REACHABLE_HOST_IP:8318
```

Use a numeric reachable host address for HTTP. `attach` executes through the
selected workspace runtime and installs only its scoped connection plus a
self-contained OpenCode adapter in `~/.config/opencode/plugins/`. It does not
replace `opencode.json` or the user's model choice. Start OpenCode normally
(including through the optional agent-tools plugin), then select a model from
`dim-responses` or `dim-chat`. Both the nested directory and the workspace home
survive ordinary recreation. Unrelated configuration is preserved; conflicting
provider IDs are rejected rather than overwritten. The adapter is also exported
as `@slop-lab/dim-plugin-llm-router/opencode` for explicit integrations.

`DIM_LLM_ROUTER_CONNECTION_FILE` can select another workspace-side connection
file. That file contains a revocable DIM access token, not provider credentials.
Nested tools can read it: possession permits that workspace's configured route
and budget, not another workspace's usage or upstream account administration.

```bash
dim llm usage my-workspace --config /home/operator/.config/dim/llm/router.json
dim llm revoke my-workspace --config /home/operator/.config/dim/llm/router.json
```

Reattaching rotates the token but does not reset usage. Discard or UUID
replacement denies new requests; active calls recheck identity/revocation once
per second and request best-effort upstream cancellation. The agent can also
inspect its own `GET /v1/usage` using its scoped token. Host administrators can
inspect the private captures under `state/captures/REQUEST_UUID/`.

Codex can use an explicit custom Responses provider pointed at the same router
with the scoped bearer token; no HTTPS interception, host certificate authority
or copying of ChatGPT authentication files is needed. This is optional client
configuration; DIM does not rewrite an existing Codex configuration.

## Accounting and capture contract

- Model allowlists and route selection come from the authenticated grant.
  Arbitrary backend paths, stateful response lookups/continuations and
  caller-selected accounts are rejected. Caller headers are not forwarded.
- Request/concurrency admission is atomic. Defaults: two active calls and 1000
  admitted requests per UTC day, 1 MiB request, 16 MiB response, five-minute
  deadline, 256 MiB retained capture allowance per workspace. These are local
  limits, not provider subscription limits or strict token/currency ceilings.
- Every admitted request has a durable record before dispatch. Request capture
  is synced before dispatch; received response chunks are synced before being
  forwarded. Capture exhaustion fails closed. Raw bodies are host-private;
  authorization headers are excluded. This is an application-body capture,
  not a complete HTTP/TLS wire capture or proof of client delivery.
- Only observed backend-reported usage is normalized; provider billing provenance
  is not independently verified. Cached/reasoning details remain in
  raw usage and are not added twice. Missing usage stays `null`/unknown.
  Requested and observed model names are separate. No account identity or
  provider remaining allowance is guessed from a model name.
- The router does not replay failed/partial requests. Disconnect and timeout
  abort its backend request; provider cancellation remains best effort. A
  restart marks unfinished dispatch uncertain and preserves its request count,
  capture bytes and unknown usage. Administrative readers do not recover a live
  service's requests. One kernel guard owns service recovery.
- Capture retention is deliberately explicit: existing captures are not silently
  deleted. Reaching the allowance blocks more inference. Choose a new reviewed
  archival/retention policy rather than deleting the accounting database to
  recover quota. Account login, refresh, management UI, multi-account balancing,
  token-price estimates and application conversation memory remain outside DIM.

No live ChatGPT account was accessed by the repository tests. The real HTTP
suite verifies isolated credentials, exact streaming bodies, tool-call data,
usage, quotas, cancellation, revocation and restart uncertainty with a local
backend. Operator login and one real provider request remain deployment checks.
