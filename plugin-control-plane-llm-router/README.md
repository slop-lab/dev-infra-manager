# Control-plane LLM router

`@slop-lab/dim-plugin-control-plane-llm-router` runs independently of DIM workspace core and host stores. It owns project policy, private upstream credentials, principals, durable usage and inert exchange archives. Projects are accounting identities and require no managed Git repositories.

```sh
dim installer install control-plane plugin @slop-lab/dim-plugin-control-plane-llm-router@0.10.0
```

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
A separate operator-approved live check completed device login and real Codex
inference through OpenCode inside a Sysbox workspace. Automated source tests
continue to use isolated fake backends. Forced token refresh and multiple real
account switching are separate checks; see [attachment acceptance](docs/attachment-acceptance.md).

Primary references reviewed for this integration:

- [Pinned CLIProxyAPI login source](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.33/cmd/server/main.go)
- [CLIProxyAPI configuration](https://help.router-for.me/configuration/options)
- [Current management API v8](https://help.router-for.me/management/apiv8)
- [OpenCode custom providers](https://opencode.ai/docs/providers/)
- [OpenCode local plugins](https://opencode.ai/docs/plugins/)

## Prepare and run

Keep the control plane and host issuer credential files private, mode 0600. Generate a random 32-byte base64url issuer key and explicitly copy it to the authorized host through your private provisioning channel. It authorizes only the configured project/route pairs, never global administration.

```sh
dim-control-plane-llm-router prepare /home/operator/.config/dim/llm \
  --backend http://127.0.0.1:8317 \
  --backend-key-file /home/operator/.config/cliproxy/access.key \
  --exclusive-account-reference personal-account \
  --model YOUR_REVIEWED_MODEL --context-tokens 128000 --output-tokens 16384 \
  --issuer-id development-host --issuer-key-file /home/operator/.config/dim/host-issuer.key \
  --issuer-project application --issuer-route default \
  --listen-host 10.0.0.1 --port 8318
dim-control-plane-llm-router project-add application --config /home/operator/.config/dim/llm/router.json
dim-control-plane-llm-router serve /home/operator/.config/dim/llm/router.json
```

Use a persistent service manager for `serve`, or load the package's `controlPlanePlugin` in `dim-control-plane` with its private config filename as the plugin configuration. The runtime starts/closes this listener; the plugin never reads a host workspace store. No host plugin or backend login is implicitly activated.

Review the schema-3 configuration before serving. `hostIssuers` explicitly lists `{id,keyFile,projects:[{id,routeIds}]}`. Arrays may be empty when no host may attach. Issuers can issue/revoke only principals derived from their own ID, project, immutable workspace UUID, route and fresh attachment UUID. They cannot change policy, export archives or administer accounts. Model/account/issuer configuration changes require service restart. Project policy changes apply transactionally to new admissions.

Ledger format 3 requires a fresh CP state directory. Combined host-router format-2 ledgers are rejected without migration because their bearer tokens were guest-visible; those tokens cannot become host-private CP principals. Existing CLIProxyAPI account/OAuth directories are separate and are not modified.

Hosts connect using the separate [host LLM router](../plugin-host-llm-router/README.md). The host holds CP principal credentials privately and exposes separate guest credentials through its UUID-fenced gateway. The control plane treats supplied workspace identity as audit metadata from its explicitly trusted issuer; workspace liveness belongs to that host. It never trusts a browser or guest claiming a different project.

## Policy and accounting

Defaults are two active calls, 1000 admissions per UTC calendar day, 1 MiB input,
16 MiB response, 1 MiB per observed SSE event, five-minute deadline and 256 MiB retained capture per project.
Service request/concurrency ceilings apply in addition to project ceilings.
Requests book their UTC day at admission, even when they finish after midnight.
There is no scheduling queue and no automatic retry or fallback.

A private policy file can be applied with:

```sh
dim-control-plane-llm-router project-policy application --config CONFIG --policy-file PRIVATE_JSON
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
dim-control-plane-llm-router usage application --config CONFIG
dim-control-plane-llm-router active CONFIG
dim-control-plane-llm-router pause application --config CONFIG
dim-control-plane-llm-router resume application --config CONFIG
dim-control-plane-llm-router disable application --config CONFIG
dim-control-plane-llm-router enable application --config CONFIG
dim-control-plane-llm-router principal-revoke development-agent --config CONFIG
dim-control-plane-llm-router cancel REQUEST_ID --config CONFIG
dim-control-plane-llm-router resolve REQUEST_ID --config CONFIG [--usage-file PRIVATE_JSON]
dim-control-plane-llm-router usage-export application --config CONFIG --output PRIVATE_NDJSON
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
dim-control-plane-llm-router capture REQUEST_ID --config CONFIG --output NEW_PRIVATE_DIRECTORY
dim-control-plane-llm-router capture-delete REQUEST_ID --config CONFIG
dim-control-plane-llm-router retention application --config CONFIG --before 2026-10-01T00:00:00Z
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
dim-control-plane-llm-router backup CONFIG --output NEW_PRIVATE_BACKUP --backend-state-quiesced yes
dim-control-plane-llm-router restore PRIVATE_BACKUP --output NEW_PRIVATE_INSTALLATION
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
