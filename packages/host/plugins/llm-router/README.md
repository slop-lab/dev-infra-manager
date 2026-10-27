# Host LLM router integration

This optional host plugin attaches existing workspaces to a separately operated [control-plane LLM router](../../../control-plane/plugins/llm-router/README.md). It owns local workspace liveness checks, a persistent gateway and the OpenCode adapter. It never stores provider credentials or project ledgers. Its operator commands manage a local or remote router through a separate private operator connection. Installing this one host plugin exposes both `dim llm` and `dim llm-router` on the selected host; no CLI companion is needed. The control-plane service remains independent of workspace core.

```sh
dim installer install plugin @slop-lab/dim-host-plugin-llm-router@0.10.0
dim llm prepare /home/operator/.config/dim/llm-host \
  --control-plane https://llm.example.test \
  --issuer development-host --issuer-key-file /home/operator/.config/dim/host-issuer.key \
  --endpoint http://127.0.0.1:8319 --listen-host 127.0.0.1 --port 8319
dim llm serve /home/operator/.config/dim/llm-host/gateway.json
```

Run `serve` under a persistent service manager on that selected host. The gateway
can stay on host loopback: the shared workspace exec/stdio channel carries guest
requests to its named service, with no guest-to-host bridge firewall rule.
`--endpoint` describes the host gateway, not the endpoint delivered to guests.
Install alone enables no gateway. Provision its private issuer key explicitly;
its CP policy must allow the selected project and route.

```sh
dim llm attach development --config /home/operator/.config/dim/llm-host/gateway.json \
  --project application --route default
```

Attach checks that the actual workspace is initialized and running and fences delivery by immutable UUID. Its guest token authenticates only to the local gateway, never directly to CP. CP principal tokens and the scoped issuer key stay private on the host. Every gateway request checks local workspace identity and running state; active streams abort when the workspace stops, disappears or its name is reused. The gateway does not impose a separate connection-count cap; request concurrency
is governed by the control-plane policy. All six service/project limits default
to `null` (unlimited); no extra gateway upload-size or request-duration cap is applied.
The gateway cannot call CP issuer/operator endpoints and forwards only application protocol routes with rewritten authentication. A successful reattachment atomically selects one current binding for that workspace across all projects/routes and fences old tokens and streams before remote principal cleanup. Failed helper delivery preserves the previous working binding. A fresh attachment UUID prevents provisional issuance from rotating an existing credential; project accounting history remains stable.

One workspace-global attachment lock serializes reattachment across configuration
paths. The host pins the selected gateway's configuration identity; changing
gateway identity or configuration path is rejected until the prior attachment
is explicitly retired. Failed preparation or credential delivery retains or
restores the previous private guest connection. Recovery of a legacy direct
connection without a host selection requires explicit reattachment through the
same gateway; host-private binding evidence is checked before adoption.

Attach installs a
private connection at `~/.config/dim/llm-router.json` and a self-contained
OpenCode adapter at `~/.config/opencode/plugins/dim-llm-router.js`, preserving
unrelated configuration files. `dim tools run WORKSPACE opencode`, its saved
continuation, and `dim tools server WORKSPACE` route the native `openai/*`
provider through the scoped workspace gateway. OMO's role-specific model names,
variants, category choices, selected profile and fallback chains stay unchanged.
Other providers keep their own connections. Only OpenAI models offered by the
attached route are exposed. If an `openai/MODEL-fast` name is absent but `MODEL`
is served through Responses, OpenCode exposes that name as an alias whose API
model ID is `MODEL`. A real `MODEL-fast` entry always takes precedence. Role names,
model selections and variants remain unchanged; the fallback does not promise
fast-tier execution. Other unavailable models fail rather than switching to a
direct OpenAI connection. The OpenAI SDK's transport also uses the gateway when
an existing OpenCode authentication plugin is installed.

Model discovery leaves unknown context/output limits unset. Native `openai/*`
models, including `-fast` aliases, then inherit OpenCode's own model catalog
instead of receiving invented context or output bounds. Explicit per-model
limits remain user-owned; custom DIM providers need route/user metadata when
OpenCode has no catalog entry for them.

Generated provider options disable header and stream-chunk deadlines with
OpenCode's supported `false` value, not zero. Explicit positive or `false`
OpenAI deadlines remain unchanged. This keeps the generated configuration
valid for the pinned OpenCode consumer without changing model selection.

Main, small/background and role-specific model choices belong to OpenCode and
OMO. Attachment installs only routing credentials and helpers; it neither selects
a default model nor changes user model choices. Responses requests use
`store:false` and full message history, not provider-side continuation identifiers.
The adapter also registers `dim-responses/*` and `dim-chat/*` for explicit route
selection. Existing DIM-owned provider ID conflicts are rejected.

The guest launch hook preserves `~/.omo/omo.jsonc`, including comments and model
chains. It removes only the previously generated `profiles.dim-router` when its
exact saved ownership metadata matches; user edits and other profiles survive.
Before each launch it also removes only OMO's generated connected-provider and
provider-model inventory files, forcing the pinned plugin to rebuild them from
the current OpenCode provider catalog instead of retaining a failed or stale
route snapshot. OMO configuration, OpenCode authentication and session storage
are not changed. A configured routed model that is absent from the recovered
route fails with its provider/model name and an explicit configuration or route
remediation instead of a generic availability error.
The launch hook validates the attached route before starting OpenCode; a failed
discovery cannot silently start a process without its routing adapter. Owned
server startup/reuse also checks the actual configured routing and primary-agent
inventory. A stale process whose adapter did not load is restarted only after
the route recovers; an unavailable configured agent fails without renaming roles
or changing models. Explicit `providers` mode keeps direct OpenAI routing intact.
No upstream key or host plugin is installed in the guest. To retain direct OpenAI
provider connections too, set `DIM_LLM_ROUTER_OPENCODE_MODE=providers` when
launching OpenCode/helpers. This registers the DIM providers without redirecting
`openai`.

If attachment/model/token/configuration changes after the owned OpenCode server
was launched, rerun `dim tools server WORKSPACE`: its private configuration
fingerprint restarts only that owned process while retaining Web credentials.
Unchanged configuration reuses the process. The adapter fetches the current route
catalog through the authenticated host gateway at each OpenCode process startup;
all-model routes need no reattachment after models change. Restart an existing
OpenCode server to reload its model catalog. An unavailable catalog fails visibly
instead of falling back to the attachment’s stale snapshot. Open TUI/run/resume sessions read the
new configuration at their next launch; an already active session is not killed.
`DIM_LLM_ROUTER_CONNECTION_FILE` can select another private guest connection.
The adapter is also exported at `@slop-lab/dim-host-plugin-llm-router/opencode`.

No repository `.dim` declaration is required. After attachment, the installed
host plugin repairs its small OpenCode helpers whenever the workspace becomes
ready, retaining the guest connection and its scoped credential. It does not
issue a new credential or select another route during recovery. Inside the
workspace, `dim-workspace plugins` advertises the integration and reports
whether its local connection can reach the gateway. An unattached workspace
shows setup instructions rather than an active router. Deleting the private
connection requires an explicit host-side attachment again.

## Verify the OpenCode configuration consumer

From the repository root, with the reviewed OpenCode 1.18.31 binary:

```sh
pnpm --dir tests exec tsx scenarios/llm-router/opencodeConsumer.e2e.ts /absolute/opencode-1.18.31
```

This explicit gate passes adapter-generated configuration to the actual pinned
server, checks its `/config` response, creates a session and verifies HTTP
authentication. It uses a temporary HOME and XDG roots, a synthetic authenticated
model catalogue and an environment allowlist. It never loads live credentials,
OMO configuration or user sessions. Its private server and temporary files are
removed on success and failure. The check does not load OMO or establish real
provider inference, tool execution, guest connectivity or multi-host readiness.

To additionally exercise pinned OMO 4.19.4's generated inventory refresh and
actual configured-agent discovery, supply its reviewed local `dist/index.js`:

```sh
pnpm --dir tests exec tsx scenarios/llm-router/opencodeConsumer.e2e.ts \
  /absolute/opencode-1.18.31 /absolute/oh-my-openagent/dist/index.js
```

This mode still uses a synthetic model catalogue and requests no inference.

Codex may use an explicitly configured custom Responses provider with this same
scoped bearer token. No TLS interception or copying of ChatGPT authentication is
needed. DIM does not rewrite an existing Codex provider configuration.

## Operator commands

Install this host plugin to use `dim llm-router --help`. It connects to a router's explicit private operator connection; it does not open the service database or install a router backend.

```bash
dim llm-router account.create --connection /absolute/operator.json --provider codex
# Use the returned generated ID to start device login:
dim llm-router account.login.start --connection /absolute/operator.json --account ACCOUNT_ID
dim llm-router account.rename --connection /absolute/operator.json --account ACCOUNT_ID --reference "Work account"
dim llm-router overview --connection /absolute/operator.json
dim llm-router requests --connection /absolute/operator.json --active true
dim llm-router project.state --connection /absolute/operator.json --project demo --action pause
```

Enrollment generates a unique account ID and provider label unless `--account` or `--reference` is supplied. Labels can be changed later while account IDs, credential partitions and usage attribution remain stable.

To make a router available through a controller to DIM Web, select its private
operator connection on that controller:

```bash
dim llm-router connect --connection /absolute/controller/operator.json
dim llm-router console describe --json
```

The router may run on another control-plane machine. Selection stores only an
owned mode-0600 pointer in `$XDG_CONFIG_HOME/dim/llm/operator-selection.json` (or
`~/.config/dim/llm/operator-selection.json`); the connection and key remain private
on the controller. Without that pointer, discovery uses `dim/llm/operator.json`
under the same configuration root. Trusted host processes can instead set
`DIM_LLM_ROUTER_OPERATOR_CONNECTION_FILE` to an absolute operator connection.
An issuer connection for workspace attachments cannot authenticate operator actions.

Discovery publishes allowed operation descriptors and an opaque `selectionId`.
This identifies the selected endpoint and operator authority independently of
Native Git or deployment generations. Every bridged invocation requires
`--expected-selection HASH`; changed endpoint, actor or credentials require a
Web feature reconnect. The fingerprint is checked against the exact connection
and key snapshot used for the HTTP request. Web sends JSON through bounded stdin
(`--input -`), keeping provider API keys out of process arguments. Read-only
operator actors expose only their permitted read operations.
The owner-specific `console invoke` JSON result is a versioned `success` or
`rejected` envelope. Success contains the validated operation output; rejection
contains only a bounded HTTP 4xx status and fixed public error code. Transport or
unreadable-result failures remain nonzero command failures. This preserves known
rejection versus indeterminate execution across the controller bridge without
exposing raw service bodies or changing the generic CLI-host wire contract.

Project policy replacement takes `--policy-file` with an owned mode-0600 JSON file. Each operation rejects unrelated flags and validates its arguments with the same definition used by the service and Web plugin. Workspace inference principals and host issuer credentials cannot authenticate this interface.

The package also provides the standalone `dim-llm-router` executable with the same arguments (omit the `dim llm-router` prefix). This client requires no host runtime, local workspace installation or control-plane service implementation. Its host-core peer is optional; this isolated executable imports only the remote client and operation contracts, without loading the workspace gateway or host integration.
