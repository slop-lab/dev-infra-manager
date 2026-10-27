# Web feature plugins

The console keeps login, sessions, origin checks, host workspace operations and
navigation in `@slop-lab/dim-web`. Optional features own their server connection,
validated operations and browser panel in separate Web plugin packages. Shared
operation declarations live in `@slop-lab/dim-contracts-operations`; feature
clients can reuse their input, output and access contracts across CLI and Web.
The feature clients are `@slop-lab/dim-service-client-llm-router`,
`@slop-lab/dim-service-client-execution` and `@slop-lab/dim-service-client-native-git`;
none starts its authoritative service.

A Web plugin is installed on the trusted Web server, not in a repository or
workspace. Installing a host or control-plane service does not automatically
execute its browser code. Operators choose reviewed matching package versions
and explicitly select them in the private Web configuration:

```json
{
  "plugins": [
    {
      "package": "@slop-lab/dim-web-plugin-llm-router",
      "config": { "connectionFile": "/absolute/operator/llm.json" }
    },
    { "package": "@slop-lab/dim-web-plugin-execution" },
    { "package": "@slop-lab/dim-web-plugin-native-git" },
    { "package": "@slop-lab/dim-web-plugin-agent-tools" },
    { "package": "@slop-lab/dim-web-plugin-external-urls" }
  ]
}
```

This is a fragment of the full Web configuration, which retains its listener,
accounts, session settings and any host operations. A plugin selection without
`config` can use its optional `autoConnect` adapter
when trusted host controllers are configured. That adapter discovers its own
feature connection and scope through those controllers. Without an adapter or
controllers it appears with connection instructions and makes no service calls.
Browser users cannot select server credential paths.
An adapter may begin discovery without delaying the shared Web catalog. Native
Git coalesces concurrent refreshes and returns freshly attested ready controllers
without waiting for unrelated slow controllers. Initial discovery remains
unavailable; later refreshes may retain the last successful catalog for
presentation only. Every operation joins or starts a fresh selected-controller
describe before checking scope and generation. A completed failure clears availability.
Configuration and operator connection files must be owned regular mode-0600
files. Keep their credentials on the Web server.

A feature-only console can be initialized from this private selection file with:

```sh
dim-web init-features /absolute/features.json --output /absolute/web.json --roles read,operator
dim-web serve /absolute/web.json
```

The selection file may include `pluginHome` to name the installed package runtime
and `operations` to include trusted host settings. Browser roles are explicit;
choose reviewer authority separately when needed. Initialization verifies
configured feature connections before writing a fresh account. At service
startup, an unavailable backend disables its feature while other features remain
usable. Reconnect retries the same server configuration and attests it again;
it cannot change connection paths or grant account authority.
Reconnect requires the browser `operator` role because it replaces shared server
connection state; read-only accounts cannot interrupt another user's operations.
Reconnect is also available for an active feature after service replacement.
Mounted forms retain drafts; refresh the feature's data after reconnecting.

`install-local` installs these Web plugins and their matching dependency
closure in the separate `DIM_DATA_HOME/web/runtime` runtime. It adds missing
selections while preserving accounts and all existing plugin configuration.
Explicit feature configuration always takes precedence over controller discovery.
Workspace feature contributions appear inside each workspace's management row,
without a separate tab or another workspace selector. **Workspace tools**
discovers the optional `agent-tools` host plugin. In a running workspace, explicitly install OpenCode or Codex,
then start, inspect or stop the OpenCode server. Server actions bind the selected
workspace UUID so a stale page cannot stop a replacement workspace's process.
Tool installation and server changes require the operator role. The server stays
on workspace loopback; the panel explains approved ingress or local forwarding
and the workspace-private credential location. No tool credential is returned
to the browser, and starting a server does not grant public network exposure.
With the optional External URLs host plugin, **External routes** in that same
row lists configured ingresses and creates a route to OpenCode's port 4096 or
another workspace/nested-container service. Approval and revocation are explicit
operator actions. DNS and shared-ingress host credentials remain server-side.
Only a newly added LLM router selection discovers the conventional private
`XDG_CONFIG_HOME/dim/llm/operator.json` connection automatically. Native Git and
Execution discover their own connections through configured controllers. Execution
requires the controller's execution-worker plugin and uses its selected control
plane's generated query and optional operator roles; the panel selects a controller
explicitly. Direct connections remain available through private configuration.
The LLM router CLI
plugin remains an explicit installation; installing the Web console does not
enable it on a host.
When a private `llm/operator-service.json` has been retained, source installation
also restores its isolated operator runtime and owned user service before
starting the console. It preserves router credentials and ledger data. A fresh
installation without that optional configuration does not create a router.
When `llm/router.json` contains the current control-plane router configuration,
source installation restores its full inference/API listener instead, so managed
account changes reach inference. A retained `llm-host/gateway.json` also restores
the host routing plugin and its gateway service. Reinstall retains private managed
account state, Codex authorization and request captures with the router ledger.
It also retains the exact explicitly configured third-party account backend
executable; unrelated backend artifacts and DIM package runtimes are replaced.

The execution plugin config accepts an absolute `queryConnection` path and an
optional `operatorConnection`. Query-only connections expose job lists and
results; cancellation, retry and worker capacity require the operator connection
and an operator browser role. The Native Git plugin config requires
`reviewerConnection` and a `projects` array of `{projectId, repositoryIds}`
entries (with optional display `name`); `promoterConnection` enables protected promotion and
`syncConnection` enables upstream fetch, merge proposals and publishing. Each
connection is a private absolute file path. See the
[LLM router](../../packages/web/plugins/llm-router/README.md),
[execution](../../packages/web/plugins/execution/README.md) and
[Native Git](../../packages/web/plugins/native-git/README.md) package guides for
complete feature configuration.

Plugins export `webPlugin` using `@slop-lab/dim-web/plugin-api`. Their declaration
provides a unique ID, title, bounded asset map, browser entry and operation
contracts. `create(config)` supplies server-side operation handlers. Each
operation declares read, operator or reviewer access plus input and result
validation. The console checks session roles and CSRF before invoking an
operation. A handler still authenticates to its authoritative service, which
retains its own policy and concurrency checks.
Server adapters can throw the `HttpResponseError` exported by
`@slop-lab/dim-web/plugin-api` when they can provide a sanitized HTTP outcome.
Use a 4xx response only for an established rejection. A dispatched operation
whose result was lost or could not be validated must use a 5xx response so the
browser keeps the write locked for owner-state reconciliation.

A plugin can declare `surfaces: ["workspace"]` to contribute directly to workspace
management. Omitting `surfaces` selects navigation; a plugin can explicitly select
both. Workspace mounts receive `context.workspace` with `hostId`, `name`, `id`
and `phase`, plus `refreshWorkspace()`. Their lifecycle follows the exact row UUID,
phase and browser session. `isCurrent()` and the shared transport reject calls
after disposal. Host-side handlers still verify UUID ownership for every action.
Workspace contexts also provide `openFeature(featureId)`, which opens and focuses
an installed feature section in the same workspace row. It returns `false` for
an absent feature or an expired mount; it cannot navigate to another workspace
or grant additional operations. Workspace tools uses this to open External
routes when configuring access to an OpenCode server.

The browser entry exports `mount(container, context)`, optionally returning a
cleanup function. `context.operations` lists the currently permitted operation
names, descriptions and access roles; `context.invoke(name, input)` uses the
authenticated transport and validated server operation. `context.isCurrent()`
guards asynchronous rendering after sign-out or session replacement. Reconnect
updates the existing operations array, so check availability when dispatching.
Keep credentials and connection selection server-side, render results as text,
and dispose listeners or polling when the console calls the cleanup function.
Panels must distinguish a confirmed mutation from a failed subsequent refresh
and preserve unsaved inputs when data or connections are refreshed.

Both browser surfaces receive `context.ui`, the shared `WebPluginUi` primitives:
`element`, `button`, labeled `input` and `select`, live-region `feedback`, and a
semantic, horizontally scrollable `table`. Buttons support primary, secondary
and danger variants; feedback supports status and error tones. Text and table
cells are rendered as text, not HTML. Plugins retain ownership of domain forms,
operation selection and state rather than deriving forms from operation schemas.

Navigation surfaces also receive the session-scoped `context.navigation` broker.
`hasFeature(id)` reports only an installed navigation destination;
`openFeature(id, target)` lazily mounts it once and passes the complete target to
the single decoder registered with `context.onNavigate(handler)`. The handler
receives `(target, isCurrent)` and must check `isCurrent()` after asynchronous
reads and before applying a selection. The registration
returns its own disposer and does not change the existing `mount` return contract.
The destination rejects incomplete or unavailable targets without selecting a
fallback controller or invoking a server operation. Concurrent opens share the
mount, but only the newest request may reach the decoder; sign-out, session
replacement and destination disposal fence late results.

Use `context.ui.navigationAction(parent, { label, status, isCurrent, open })` for
related-object links. It renders the common native secondary button, owns its
pending/disabled state and writes the returned result beside the caller. Stale
completion cannot replace feedback in a later mount. A failed navigation is not
reported as a successful generic tab change.
Each mounted context receives its own lifecycle-fenced navigation capability;
retaining an old context cannot open a destination after session or workspace
replacement. Invalid targets leave the current tab and selection unchanged.

`navigation.canCreateWorkspace` is true only for an operator session with ordinary
host operations. `openWorkspaceCreate` accepts exactly `hostId`, `projectId`,
`repositoryIds` and `workingRepositoryId`; IDs must be bounded nonempty strings,
repository IDs must be unique, and the working repository must be selected. The
host must exactly match a configured host in the current session. Success opens
the existing creation form and prefills `dim://PROJECT`, repository selection,
working repository and the default container runtime without submitting. An
edited draft is retained until **Replace draft with managed selection** is chosen.
Pending or outcome-unknown creation remains locked behind current-state
reconciliation and cannot be replaced through navigation.

Transport errors carry `outcome: "unknown"` when a request loses its response,
returns a server error, or returns unreadable successful JSON. An unknown outcome
does not establish whether a mutation ran. Workspace tools and External routes
lock further changes until their authoritative status refresh succeeds. Keep
drafts, distinguish rejected requests from uncertain writes, and do not present
an automatic repeat as safe without the operation's own idempotency contract.
Execution retries retain their request UUID. Router policy edits remain bound to
their loaded project and revision, including edits made while navigation or a
save is in flight.

The browser receives feature descriptions, allowed operations and sanitized
results, never raw connection files. Feature panels own their interactions and
presentation; the shared operation contract does not generate a universal form
or turn CLI arguments into a Web API.

## Reusable Git presentation

The Native Git panel uses the DIM-independent `@slop-lab/gs-react-diff` and
`@slop-lab/gs-react-pull-requests` packages. The Web adapter owns service calls,
selection fencing, permission checks and approval confirmations. The components
receive immutable snapshots and explicit callbacks, so another Git service can
reuse them without installing DIM. Optional file-toolbar, line-gutter and
below-line render slots support focused extensions without a general UI registry.
Blame and discussion are separate server plugins and optional UI callbacks.

A Web plugin can bundle React inside its browser asset and use the portable DOM
mount helpers. It disposes the mounted root with its panel. This does not make
React a requirement for the Web core or other plugins. Serve optional component
styles as declared external assets; the Native Git adapter never enables inline
styles or relaxes the console CSP. See [the model and flow](../specs/git-pull-requests.md).

## Controller discovery

A reviewed plugin can implement `autoConnect(context: WebPluginContext)` in
addition to manual `create(config)`. The context exposes only the trusted
controllers from the console's private `operations.hosts` settings:

```ts
interface WebPluginContext {
  readonly controllers: readonly {
    readonly id: string;
    run(args: readonly string[], options?: { timeoutMilliseconds: number; input?: string }): Promise<unknown>;
  }[];
}
```

The core fixes each executable and host selector. Commands run without a shell
as `dim --host SELECTOR ...ARGS --json`, with at most 128 arguments, 96 KiB
UTF-8 per argument, 128 KiB total UTF-8 argument data, 32 MiB each for stdout and stderr, and a
30-second default deadline (explicit trusted options may raise it to 180 seconds). NUL arguments and transport overrides `--host`/`--json` are
rejected. Only reviewed server-side plugin code receives this capability;
browser inputs cannot select an executable, selector or generic command.

The feature owns command selection, returned data validation, discovery scope
and interpretation. The core has no Project/repository discovery schema or
feature connection convention. An automatically selected feature counts as
configured and reports ready or unavailable; reconnect repeats discovery through
the same fixed controllers. Explicit `config` uses manual creation instead and never
falls back to discovery after a credential or scope failure. Runtime operation
registration and browser role/CSRF checks are identical for either path.

A browser panel may pass a third `invoke(name, input, { timeoutMilliseconds })`
argument for a longer-running operation. The generic transport defaults to 35
seconds and accepts positive integral deadlines up to 185 seconds. Controller
and browser deadlines reject unknown options and out-of-range values before
issuing work. Plugins choose the budget; no business-operation names are encoded
in the core transport.

Trusted controller commands may pass bounded private text using
`controller.run(args, { timeoutMilliseconds, input })`. The core writes `input`
to stdin and closes it; it never appends it to argv. Keep passwords out of args,
status results and logs, and expose any explicit application credential read
as an operator operation. JSON responses use `Cache-Control: no-store`.
