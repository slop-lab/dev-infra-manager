# Host LLM router gateway

This optional host plugin attaches existing workspaces to a separately operated [control-plane LLM router](../../../control-plane/plugins/llm-router/README.md). It owns local workspace liveness checks, a persistent gateway and the OpenCode adapter. It never hosts provider credentials, project ledgers or account management. The host package depends on workspace core; the CP package does not.

```sh
dim installer install plugin @slop-lab/dim-host-plugin-llm-router@0.10.0
dim llm prepare /home/operator/.config/dim/llm-host \
  --control-plane https://llm.example.test \
  --issuer development-host --issuer-key-file /home/operator/.config/dim/host-issuer.key \
  --endpoint http://172.17.0.1:8319 --listen-host 172.17.0.1 --port 8319
dim llm serve /home/operator/.config/dim/llm-host/gateway.json
```

Use an actual private host address reachable from the workspace; the example address is not discovered automatically. Run `serve` under a persistent service manager on that selected host. Install alone enables no gateway. Provision its private issuer key explicitly; its CP policy must allow the selected project and route.

```sh
dim llm attach development --config /home/operator/.config/dim/llm-host/gateway.json \
  --project application --route default
```

Attach checks that the actual workspace is initialized and running and fences delivery by immutable UUID. Its guest token authenticates only to the local gateway, never directly to CP. CP principal tokens and the scoped issuer key stay private on the host. Every gateway request checks local workspace identity and running state; active streams abort when the workspace stops, disappears or its name is reused. The gateway cannot call CP issuer/operator endpoints and forwards only application protocol routes with rewritten authentication. A successful reattachment atomically selects one current binding for that workspace across all projects/routes and fences old tokens and streams before remote principal cleanup. Failed helper delivery preserves the previous working binding. A fresh attachment UUID prevents provisional issuance from rotating an existing credential; project accounting history remains stable.

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

Main, small/background and role-specific model choices belong to OpenCode and
OMO. Attachment installs only routing credentials and helpers; it neither selects
a default model nor changes user model choices. Responses requests use
`store:false` and full message history, not provider-side continuation identifiers.
The adapter also registers `dim-responses/*` and `dim-chat/*` for explicit route
selection. Existing DIM-owned provider ID conflicts are rejected.

The guest launch hook preserves `~/.omo/omo.jsonc`, including comments and model
chains. It removes only the previously generated `profiles.dim-router` when its
exact saved ownership metadata matches; user edits and other profiles survive.
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

Codex may use an explicitly configured custom Responses provider with this same
scoped bearer token. No TLS interception or copying of ChatGPT authentication is
needed. DIM does not rewrite an existing Codex provider configuration.
