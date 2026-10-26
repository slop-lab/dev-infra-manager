# Control-plane LLM router

`@slop-lab/dim-control-plane-plugin-llm-router` runs independently of DIM workspace core and host stores. It owns project policy, private upstream credentials, principals, durable usage and inert exchange archives. Projects are accounting identities and require no managed Git repositories.

```sh
dim installer install control-plane plugin @slop-lab/dim-control-plane-plugin-llm-router@0.10.0
```

## Backend boundary

Every account has a separate **CLIProxyAPI v8.0.33** worker. Existing operator-provided exclusive worker endpoints remain usable. Configure `accountManagement: { backendExecutable: "/absolute/path/to/cli-proxy-api" }` in the private router config to enable account enrollment. The executable must be a regular file, executable, and not writable by other users; DIM checks the pinned version before launching it.

The operator API, CLI and Web console can connect multiple independent Codex accounts and OpenAI-compatible or Anthropic-compatible API credentials. Codex enrollment requires no manually chosen account ID or label: the service generates an independent identity and starts device login from Web. After authentication, the account list uses the saved provider email when available unless the operator supplied a custom label. API connections also receive generated IDs and provider labels by default. Device login returns only the authorization URL and code. CLIProxyAPI owns OAuth login and refresh; DIM never implicitly imports host Codex authentication. Each managed account gets its own private auth directory, access key and loopback listener under `stateDirectory/managed-accounts/ACCOUNT`. API keys live only in the private worker configuration. API base URLs may include `/v1`; they must use HTTPS, or an explicit loopback HTTP address for local services.

Account credentials and routes are separate. `route.upsert` selects an account and either an explicit model list or `models: "all"`. Selecting all models performs an explicit authenticated registration step and atomically saves the account's typed `supportedModels` inventory with the route. Static all-model routes must configure that same inventory directly. Inference authorization, guest `/v1/models`, guest capabilities and principal issuance all use this registered route inventory; a transient provider availability/cooldown omission, service restart or long outage cannot remove a configured model or turn it into a principal 403. Operator `account.models` remains the separate live availability view and refreshes every 30 seconds. Live discovery never adds arbitrary names to authorization; rerun `route.upsert` to register intentional account catalog changes. Published guest inventory is the configured support contract, not a promise that every provider model is currently out of cooldown. Explicit route lists and account, principal or project revocation apply immediately. API-worker model aliases are reconciled from the registered inventory and explicit routes. CLIProxyAPI watches its configuration. New admissions read the atomically published account catalog without restarting the router. A running request keeps its admitted account. There is no automatic retry, fallback, usage-based account selection or provider-quota inference. Usage-based routing can be added independently of account enrollment; request records already retain the selected account ID.

The first read of an existing account-catalog format-1 file atomically adopts its
accounts and routes into format 2 with an empty `supportedModels` registry.
Explicit model routes continue unchanged. A legacy all-model route remains
visible but unregistered and returns an actionable service error until the
operator replaces it with an explicit list or repeats `route.upsert --models all`.
Adoption never infers authorization from the live provider catalog, and it does
not alter account credentials, labels, route IDs or usage history.

Each worker disables credential fallback and inference retry and contains only one configured API credential or Codex login partition. CLIProxyAPI performs provider protocol conversion, including Anthropic-compatible responses to the router's OpenAI-facing APIs. Attribution remains a configured exclusive-worker binding rather than proof of the provider's internal account identity. Strict token/currency ceilings, attempt-exact accounting and backend-confirmed cancellation remain unavailable.

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

Review the schema-3 configuration before serving. `hostIssuers` explicitly lists `{id,keyFile,projects:[{id,routeIds}]}`. Arrays may be empty when no host may attach. Issuers can issue/revoke only principals derived from their own ID, project, immutable workspace UUID, route and fresh attachment UUID. They cannot change policy, export archives or administer accounts. Trusted executable and host-issuer configuration changes require service restart. Account enrollment, route bindings and project policy changes apply to new admissions without restart.

Ledger format 3 requires a fresh CP state directory. Combined host-router format-2 ledgers are rejected without migration because their bearer tokens were guest-visible; those tokens cannot become host-private CP principals. Existing CLIProxyAPI account/OAuth directories are separate and are not modified.

Hosts connect using the separate [host LLM router](../../../host/plugins/llm-router/README.md). The host holds CP principal credentials privately and exposes separate guest credentials through its UUID-fenced gateway. The control plane treats supplied workspace identity as audit metadata from its explicitly trusted issuer; workspace liveness belongs to that host. It never trusts a browser or guest claiming a different project.

## Policy and accounting

All six service and project policy limits default to `null` (unlimited): concurrent
requests, UTC-day admissions, request bytes, response bytes, retained capture bytes
and request deadline. Token estimation quotas are opt-in; the default is observe-only.
The gateway and inference transport impose no separate upload, response, SSE-event
or inference deadline caps. Explicit positive limits remain available.
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
`captureBytesPerProject`, `deadlineMilliseconds`. Each field accepts `null` for
unlimited or a positive safe integer for an explicit cap. Service and project
limits intersect: the smaller finite value applies; two null values remain
unlimited. Web operators leave any limit field blank to select unlimited.
`captureMode` may also be
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
0600 files in private directories, with authenticated retrieval/export operations.

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

## Remote operator clients

The service optionally accepts independently provisioned operator actors:

```json
{"operators":[{"id":"operator","keyFile":"/absolute/operator.key","role":"operator"},{"id":"observer","keyFile":"/absolute/observer.key","role":"read"}]}
```

Add this field to the router configuration; omitting it disables operator HTTP access. Generate each key separately (`node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`) into an owned mode-0600 file. Operators must not reuse provider, host issuer or workspace credentials. Both key files and supplied keys are checked; host-issuer/workspace credentials cannot authorize operator operations. Consistent backups include configured operator keys, and restore rebinds their private paths.

The host plugin `@slop-lab/dim-host-plugin-llm-router` supplies the `llm` and `llm-router` commands through ordinary host command discovery. Its operator commands and the Web plugin use `@slop-lab/dim-service-client-llm-router` for transport and `@slop-lab/dim-contracts-llm-router` for shared operation definitions. They need a separate mode-0600 connection file `{ "schemaVersion":1, "endpoint":"http://127.0.0.1:8318", "actorId":"operator", "keyFile":"/absolute/operator.key" }`. They require no local database access. The authenticated `POST /v1/operator/operations/NAME` interface enforces read/operator roles on the service, validates input/output and records the operator actor in its audit log. Only bounded metadata is exposed; provider secrets, token hashes, local paths and prompt/response capture contents remain private. Local backup, restore and capture export remain local operator commands.

### Independent operator listener

`dim-control-plane-llm-router operator-serve /absolute/operator-service.json` starts an operator-only listener. Give it a separate loopback listen port and the same private state directory, accounts, routes and service limits as the inference service, plus dedicated `operators`. It attaches to an existing SQLite WAL only after checking the complete table/index/trigger schema against the canonical operation schema, and holds its own `operator-service.guard`. The inference service retains ownership of its database format marker: attachment never initializes a database, migrates it, or changes `user_version`. Extra triggers, columns, indexes or missing objects are rejected even when the format marker is recognized. It never performs inference recovery, takes the inference service lock, issues workspace principals, or accepts inference requests. This allows operator API deployment to run separately from inference lifecycle and workspace admission checks. Stop both listeners before a consistent backup; backup checks both ownership locks.

Operator key separation checks every stored workspace credential hash, including revoked principals and disabled projects. Missing or unreadable unrelated backend/issuer keys do not block operator diagnostics; health reports those credentials as unknown. The selected actor always requires its own valid private key.

## Account and route operations

The separate CLI operator plugin uses the same checked operations as Web:

```sh
# Omit --account and --reference to generate an ID and label; use the returned ID for login.
dim llm-router account.create --connection /absolute/operator.json --provider codex
# Explicit names are optional for scripts:
dim llm-router account.create --connection /absolute/operator.json --account personal --reference "Personal Codex" --provider codex
dim llm-router account.login.start --connection /absolute/operator.json --account personal
dim llm-router account.login.status --connection /absolute/operator.json --account personal --session SESSION_UUID
dim llm-router account.rename --connection /absolute/operator.json --account personal --reference "Work account"
dim llm-router account.create --connection /absolute/operator.json --account company-api --reference "Company API" --provider openai --endpoint https://api.openai.com/v1 --api-key-file /absolute/private-api.key
# Permit every model offered by this account, including later catalog additions.
dim llm-router route.upsert --connection /absolute/operator.json --route company --account company-api --models all
# Or restrict the route to an explicit list.
dim llm-router route.upsert --connection /absolute/operator.json --route restricted --account company-api --models-file /absolute/models.json
dim llm-router account.models --connection /absolute/operator.json --account company-api
```

The Web account panel offers the same **All models from this account** selection.
Static route configuration uses `{"id":"default","accountId":"default","models":"all"}`.
Registering an all-model route requires an authenticated account catalog endpoint;
compatible API accounts use their configured provider’s model-list endpoint.
Paginated catalogs currently require an explicit list; partial catalogs are rejected.
Registration failure leaves the prior route and supported inventory unchanged.
After registration, live catalog failure or omission does not rewrite authorization;
the registered inventory remains until an operator replaces the route or inventory.
This grants models within one account, without granting access to other accounts or routes.
The router still serves Responses and Chat Completions; catalog entries requiring
other endpoints, such as image generation, do not acquire those APIs. When the
provider supplies no token limits, discovery omits those limits. Clients retain
their own model metadata instead of receiving invented context or output bounds.
Explicit model lists may also omit `context` and `output`; supplied limits must be
positive safe integers.

Credential, connection and model files must be private mode 0600. A model file is an array such as `[{"id":"MODEL_ID","name":"MODEL_ID","api":"responses","context":128000,"output":16384}]`. Select `chat` for Chat Completions clients. A static account used by `models: "all"` includes this array as `supportedModels`; a managed account receives it atomically from `route.upsert --models all`. Account IDs are stable identities. `account.rename` changes only a managed account label and preserves its credentials, routes and usage; static configuration accounts must be renamed in their configuration. Multiple accounts may share a label; multiple accounts may use the same provider URL. Creating an account does not grant any project access: explicitly add a route to that project's policy and to the trusted host issuer's allowed routes when host attachment is needed.

Consistent backups require stopping inference, operator and credential writers. They include dynamic account/route state, API worker configuration and OAuth directories, and restore rewrites managed credential paths. A different host must provision its own trusted pinned CLIProxyAPI executable and update `accountManagement.backendExecutable`; backup archives do not contain executable code. Local reinstall retains the selected backend executable, the entire router state directory and configured operator keys. Raw keys, backend paths, refresh tokens and prompt content never appear in account-list DTOs or enrollment audit records.

## Connect a controller and the Web console

The router may run on a separate control-plane machine. The controller needs
only its reachable operator endpoint and a dedicated operator credential; it
does not need the router state directory, provider login files or workspace core
on the control-plane machine.

When preparing a router, `--operator-id console --operator-key-file /private/operator.key`
adds that separate operator to `router.json`. Generate the key as 32 random bytes
encoded as base64url in a private mode-0600 file. Do not reuse a backend or host
issuer key. Existing routers can add the corresponding `operators` entry and
restart the router. Ensure the listener is reachable from the selected controller;
use HTTPS across untrusted networks or a trusted private transport.

On the controller machine, securely provision that operator key in its own
mode-0600 file and create a private connection file:

```json
{
  "schemaVersion": 1,
  "endpoint": "https://router.control-plane.example",
  "actorId": "console",
  "keyFile": "/absolute/controller-private/router-operator.key"
}
```

```sh
dim llm-router connect --connection /absolute/controller-private/router-operator.json
dim llm-router console describe --json
```

Select the Web plugin without a direct `config` to discover the router through
its trusted controllers. Choose the controller in **LLM router**. Each controller
can select a different router. The controller retains the private connection and
credential; the Web server and browser receive typed operation results only.
Reconnecting after a selection or credential change explicitly attests the new
selection. A configured direct Web connection remains explicit and is never
silently replaced by controller discovery.

Workspace inference is separate from operator access. Configure the host's
`dim llm prepare --control-plane ROUTER_ORIGIN ...` issuer/gateway connection,
then attach workspaces as described in the host plugin README. Never give an
operator key to a gateway or workspace. Existing attached workspaces do not
change routes merely because the Web console changes its selected controller.
