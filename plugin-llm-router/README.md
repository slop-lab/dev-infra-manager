# Shared LLM access router

Install the optional base-workspace plugin explicitly:

```sh
dim installer install plugin @slop-lab/dim-plugin-llm-router@0.10.0
```

The host owns stable application projects, principals, policy admission,
account references, durable usage and private exchange archives. These projects
are accounting identities; they do not require DIM managed Git or a controller.
Several workspaces/principals can share one project's allowance. Rotating a
principal preserves project history. Guest credentials never contain upstream
keys, OAuth tokens, an account directory or a host administration socket.
Applications keep their conversations, tools, prompts and tracing systems.

## Backend boundary

Use a separately operated **CLIProxyAPI v8.0.33** instance for each eligible
account partition. CLIProxyAPI owns login and refresh; this plugin makes no
parallel refresh loop and never reads a user's Codex authentication implicitly.
Its configuration records an explicit `exclusive-worker` account binding,
`request-only` attempt visibility and `best-effort` cancellation. Other profiles
are rejected. Operator account references are stable identifiers, not inferred
from model names, array positions or filenames.

An exclusive binding means the selected backend endpoint contains only the
permitted account, with retries and paid-provider fallback disabled. Model
aliases do not establish that boundary. The operator must verify the running
backend's version and partition; this wrapper cannot attest its internal account
selection or hidden retries. Recorded attribution explicitly says configured
exclusive binding rather than an observed provider account identity. Unsupported
attempt-exact accounting, strict token/currency ceilings, stateful continuation
and asynchronous provider work are not enabled.

CLIProxyAPI's tagged host-side login flags are `-config /absolute/config.yaml
-codex-login` and `-codex-device-login`. Keep its `oauth.auth-dir` private and
persistent. Reauthorization concerns the relevant backend account only. Backend
configuration, OAuth access and real provider inference remain operator-managed.
No live ChatGPT account was used in repository verification.

Primary references reviewed for this integration:

- [Pinned CLIProxyAPI login source](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.33/cmd/server/main.go)
- [CLIProxyAPI configuration](https://help.router-for.me/configuration/options)
- [Current management API v8](https://help.router-for.me/management/apiv8)
- [OpenCode custom providers](https://opencode.ai/docs/providers/)
- [OpenCode local plugins](https://opencode.ai/docs/plugins/)

## Prepare, create a project and attach

```sh
dim llm prepare /home/operator/.config/dim/llm \
  --backend http://127.0.0.1:8317 \
  --backend-key-file /home/operator/.config/cliproxy/access.key \
  --exclusive-account-reference personal-account \
  --model YOUR_REVIEWED_MODEL --context-tokens 128000 --output-tokens 16384 \
  --listen-host 10.0.0.1 --port 8318
dim llm project-add application --config /home/operator/.config/dim/llm/router.json
dim llm policy application --config /home/operator/.config/dim/llm/router.json
dim llm serve /home/operator/.config/dim/llm/router.json
```

Review the private schema-2 configuration before serving. Accounts contain
`id`, `reference`, `endpoint`, `keyFile` and optionally `credentialDirectory` for
explicit local backend-state backup. Routes select one account ID and reviewed
model/API/context/output metadata. Additional accounts require distinct backend
endpoints. Route/model/config changes take effect at service restart; project
policy changes are transactional and affect new admissions immediately.

Use a private numeric address reachable from the guest, or an operator-provided
HTTPS endpoint. Upstream HTTP is loopback-only. Client HTTP requires an explicit
IP origin and a trusted private network; use HTTPS for untrusted networks. The
listener exposes inference and scoped reads, not operator mutations or OAuth
management. Run `serve` under the host service manager for persistence.

```sh
dim llm attach development --config /home/operator/.config/dim/llm/router.json \
  --project application --principal development-agent \
  --endpoint http://10.0.0.1:8318
```

Attachment pins the actual workspace UUID before delivering its credential.
Omitting `--principal` uses that UUID as the principal ID. Reattaching the same
principal rotates it; another principal can share the same project budget.
Reusing a workspace display name cannot adopt an old grant. Attach installs a
private connection at `~/.config/dim/llm-router.json` and a self-contained
OpenCode adapter at `~/.config/opencode/plugins/dim-llm-router.js`, preserving
unrelated configuration. Start OpenCode normally and select a model from
`dim-responses` or `dim-chat`. Conflicting provider IDs are rejected.
`DIM_LLM_ROUTER_CONNECTION_FILE` can select another private guest connection.
The adapter is also exported at `@slop-lab/dim-plugin-llm-router/opencode`.

Codex may use an explicitly configured custom Responses provider with this same
scoped bearer token. No TLS interception or copying of ChatGPT authentication is
needed. DIM does not rewrite an existing Codex provider configuration.

## Policy and accounting

Defaults are two active calls, 1000 admissions per UTC calendar day, 1 MiB input,
16 MiB response, 1 MiB per observed SSE event, five-minute deadline and 256 MiB retained capture per project.
Service request/concurrency ceilings apply in addition to project ceilings.
Requests book their UTC day at admission, even when they finish after midnight.
There is no scheduling queue and no automatic retry or fallback.

A private policy file can be applied with:

```sh
dim llm project-policy application --config CONFIG --policy-file PRIVATE_JSON
```

Its shape is `{allowedRoutes:["default"],limits:{...},captureMode:"required",
tokenMode:"observe"}`. `limits` has the same complete fields as the configuration:
`concurrent`, `requestsPerUtcDay`, `requestBytes`, `responseBytes`,
`captureBytesPerProject`, `deadlineMilliseconds`. `captureMode` may also be
`best-effort` or `metadata`. `tokenMode:"estimate"` requires positive
`tokensPerUtcDay` and `estimatedTokensPerRequest`. Estimated reservations are
atomic with other admission checks; overshoot remains possible. Unknown usage
retains its reservation. `tokenMode:"strict"` is explicitly rejected because
this backend binding has no verified consumption/attempt upper bound.

Only observed request-level backend token totals are normalized. Cache/reasoning
subfields are retained without double addition. Missing/unverified usage is
unknown, not zero. Provider remaining subscription allowance and monetary costs
are not inferred. Usage includes requested/observed model, account binding,
principal, one backend-call attempt ID, freshness and observation limitations.
Hidden backend retries cannot be represented as exactly observed attempts.

Execution, delivery, accounting and capture are separate states. Disconnect,
timeout, cancellation or crash after dispatch can retain uncertain physical
occupancy and token reservations. Restart never blindly replays inference or
refunds uncertain work. A normal complete response releases physical occupancy;
missing final usage can still require accounting reconciliation. Delivery means
the server's write boundary, not proof that a remote application consumed it.

```sh
dim llm usage application --config CONFIG
dim llm active CONFIG
dim llm pause application --config CONFIG
dim llm resume application --config CONFIG
dim llm disable application --config CONFIG
dim llm enable application --config CONFIG
dim llm principal-revoke development-agent --config CONFIG
dim llm cancel REQUEST_ID --config CONFIG
dim llm resolve REQUEST_ID --config CONFIG [--usage-file PRIVATE_JSON]
dim llm usage-export application --config CONFIG --output PRIVATE_NDJSON
```

Pause stops new admissions while preserving active policy snapshots. Disable or
principal revocation requests cancellation of active work. Cancellation is
requested, never misreported as confirmed upstream termination. After inspecting
an uncertain execution, `resolve` releases its physical occupancy; without
usage it retains unknown token reservations. An optional resolution file with
nonnegative `inputTokens`/`outputTokens` is an audited **operator** observation.
Resolution cannot alter active requests. Policy, credential, resolution and
archive operations append audit events rather than deleting accounting history.

`projects`, `principals`, `health` and `active` take a configuration path.
`health` checks backend `/v1/models` authentication without billable inference;
it does not claim provider reachability, refreshed OAuth or remaining quota.

## Exchange capture, retrieval and retention

Required full recording syncs the request before durable dispatch intent and
syncs ordered response chunks before forwarding. Archive failure prevents new
work or aborts affected output. Best-effort mode continues with explicit failure
or gaps. Metadata mode intentionally promises no payload capture. Content is
never masked, summarized or semantically deduplicated; token-like text and
repeated context remain byte-for-byte data. Remote images/files referenced in a
request are not fetched by the recorder.

The boundary is **client application-protocol bodies**, not HTTP/TLS packets,
authentication headers, translated upstream payloads or provider-internal
reasoning. Every manifest names this boundary, account attribution quality,
integrity hashes and completeness. Completed output may coexist with failed
capture or unknown usage. Exports and payload downloads treat content as inert
attachments and never run tools or replay inference.

```sh
dim llm capture REQUEST_ID --config CONFIG --output NEW_PRIVATE_DIRECTORY
dim llm capture-delete REQUEST_ID --config CONFIG
dim llm retention application --config CONFIG --before 2026-10-01T00:00:00Z
```

Deletion and retention expiry are distinct durable states. Accounting remains;
retained-storage allowance is reclaimed. Existing backups retain their copies
until the operator expires those backups separately. Private archives, exports
and backups may contain real secrets from application content; permission to
read an archive therefore grants access to those secrets. They are owned mode
0600 files in private directories, with bounded retrieval/export operations.

Authenticated projects can read `GET /v1/usage`, `/v1/capabilities`,
`/v1/requests/ID/capture`, `/v1/requests/ID/request` and
`/v1/requests/ID/response`, or request `POST /v1/requests/ID/cancel`.
Another project's IDs return no record. Payload downloads use an inert MIME
and attachment disposition. Model bodies pass unchanged; unsupported provider
continuation/account-routing fields fail explicitly. `x-dim-request-id` supplies
a service ID without overwriting provider response or tool IDs.

## Backup and restore

```sh
# Stop this router first. If credentialDirectory is configured, also stop that
# backend's credential writers before affirming the explicit acknowledgement.
dim llm backup CONFIG --output NEW_PRIVATE_BACKUP --backend-state-quiesced yes
dim llm restore PRIVATE_BACKUP --output NEW_PRIVATE_INSTALLATION
```

Backup uses SQLite's consistent snapshot, private captures, access keys,
configuration and checksummed inventory. Explicitly configured local backend
credential directories are copied with strict ownership/no-symlink checks;
otherwise the manifest labels that account's backend credentials
`external-not-included`. Back up a remote backend with its own operator tools.
Restore validates hashes, reconstructs private paths and preserves unknown
reservations without replaying old inference. It does not start a backend or
log in to an account. Protect backups as credentials and transcripts; this
implementation does not claim encrypted storage or a hidden decryption key.

See [attachment acceptance](docs/attachment-acceptance.md) for tested guarantees
and the remaining authenticated-backend integration boundaries.
