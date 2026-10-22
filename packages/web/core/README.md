# `@slop-lab/dim-web`

Authenticated operations console for local or SSH development hosts and explicit
feature plugins. Ordinary Git hosts need no control plane. Browser accounts
have explicit `read`, `operator`, and `reviewer` roles. Host selectors, executable
paths, service credentials and worker leases remain on the server.

## Ordinary Git hosts

For repository development, `just install-local` installs and configures this
package automatically, with a local host connection and a loopback user service.
Read the initial login from `~/.config/dim/web/login.txt`. Repeated installs keep
the existing account. See the [local source workflow](../../../docs/guides/usage.md#install-development-sources)
for remote browser access and service management.

Install the optional package and create a mode-0600 operations settings file:

```json
{
  "hosts": [{
    "id": "devbox",
    "selector": "configured-ssh-host",
    "executable": "/absolute/path/to/dim"
  }],
  "consoles": [{ "name": "Agent console", "url": "https://agents.example.internal/" }]
}
```

`selector` names an existing DIM host configuration belonging to the service
account. `executable` is a trusted installed public DIM CLI. It is executed with
separate allowlisted arguments, without a shell. The browser cannot change it,
choose an SSH address, execute arbitrary commands, or select a state directory.
Console URLs must use HTTPS or loopback HTTP and contain no credentials, query
or fragment. They open separately and retain their own service authentication.

```sh
mise use --raw --global 'npm:@slop-lab/dim-web@0.10.0'
dim-web init-operations /absolute/operations.json --output /absolute/web.json --port 9081
dim-web serve /absolute/web.json
```

Save the generated browser password. Initialization creates a new private
configuration and stores only its scrypt hash. Existing files are never
replaced. Operators can create workspaces from HTTP(S), SSH or Git repository URLs on an explicitly
configured host, with an optional ref, runtime, image and CPU/memory/PID limits.
Empty limits use the host defaults; `unlimited` removes a limit. A VM workspace
requires its provider to be installed and an explicit reviewed image fingerprint.
Creation uses ordinary Git and needs no control plane. The UI lists workspaces
and their observed runtime status, starts,
stops, restarts and recreates them, updates CPU/memory/PID limits, and discards
persistent data after explicit browser confirmation. Actions on existing
workspaces pass the selected
workspace UUID through the public CLI's `--expect-id` guard; the host checks it
inside its workspace lock before changing state. A reused name cannot redirect
an action to a replacement workspace.

The workspace list is the starting view. Choose **New workspace** on a host;
only the repository URL and name are needed for the default container runtime.
**Advanced options** contains Git refs, managed repository selection, runtime,
image and resource limits. Refreshing services or acting on another workspace
keeps unfinished creation and resource edits. Cancel closes the creation form
without clearing its draft; successful creation resets it after the host accepts
the request. Errors stay beside the affected form or host, with a retry for host
lookup. **Settings** holds resource edits, recreation and explicit discard
confirmation; canceling discard sends no mutation.

Each host also has a scoped refresh, name search and state filter. Filters retain
mounted rows, open settings, focus and drafts, and distinguish no matches from an
empty or unavailable host. Resource settings identify unsaved edits and can reset
to the last limits returned by the host. Examples include `unlimited`; removing a
limit may replace the runtime while preserving workspace data.

If a mutation response is lost, the console reports an unknown outcome and blocks
repeat submission until **Check current state** succeeds. It applies the same gate
when the host accepts a mutation but the following workspace read fails. Creation
cannot be resubmitted under a name found during reconciliation, and the console
does not claim that a discovered workspace was created by the interrupted request.

Source examples and suggested names distinguish ordinary Git URLs from
`dim://my-project` managed sources. The latter requires an existing project on
the selected host; repository selection appears only for managed sources.
Missing images, runtime prerequisites, repository access, unknown refs and name
conflicts produce fixed recovery guidance. Raw host diagnostics, repository
credentials and private paths stay outside Web responses. Incomplete initial
setup is identified separately from a stopped workspace: inspect it before an
explicit discard and replacement; Start and Recreate require completed setup.

Sign in at the exact configured `publicOrigin`, including hostname and port.
`localhost` and `127.0.0.1` are different browser origins. A rejected login from
another origin identifies the configured URL without weakening the origin check.

The disposable browser regression covers workspace creation/recovery, retained
drafts, resource updates, discard cancellation, host retry, read-only access and
logout. From the repository root after dependencies are
installed:

```sh
DIM_CHROMIUM=/absolute/path/to/chromium node \
  --import ./tests/node_modules/tsx/dist/loader.mjs --conditions=dim-source \
  tests/web/operations.e2e.ts
```

The host CLI in that fixture is synthetic; HTTP authentication is real. It does not replace Docker/Sysbox runtime verification.

## Feature plugins

LLM routing, execution, Native Git review and workspace tools belong to optional Web plugins.
The console shell provides authentication, sessions, origin and CSRF checks,
workspace lifecycle controls, feature discovery and trusted packaged assets.
Plugins can contribute to navigation or directly to each workspace management
row. Workspace tools and External routes use the row's exact host and UUID.
It has no required control-plane package or built-in service API proxy.

[Web feature plugins](../../../docs/guides/web-plugins.md) describes package
installation, configuration and the server/browser extension contract. The
repository development installer installs the matching LLM router, execution,
Native Git, workspace tools and External routes Web packages in a separate runtime. Connections remain explicit;
installing a feature does not grant service authority. An unavailable backend
leaves its feature unavailable while workspaces and other features keep working.
Reconnect retries the same private configuration and verifies its identity again.

To initialize a feature-only console, write a private specification file:

```json
{
  "pluginHome": "/absolute/web-plugin-runtime",
  "plugins": [
    { "package": "@slop-lab/dim-web-plugin-llm-router",
      "config": { "connectionFile": "/absolute/operator/llm.json" } }
  ]
}
```

The specification can also include the `operations` settings shown above.
Choose browser roles explicitly; service credentials still retain their own
independent authority. Initialization loads configured plugins and validates
connections before creating the configuration or exposing a listener.

```sh
dim-web init-features /absolute/features.json --output /absolute/web.json --roles read,operator
dim-web serve /absolute/web.json
```

The `pluginHome` package runtime defaults to `DIM_DATA_HOME/web/runtime/current`
when omitted. Install only reviewed matching versions there.
A `{ "package": "..." }` selection can use that plugin's optional automatic
connection adapter through configured trusted host controllers. Without an
adapter or controllers it appears with connection guidance and makes no service
calls. Manual `config` takes precedence and never falls back after failure.
Each plugin validates its discovered scope; browser requests cannot invent or
widen that scope.
See [Native Git](../plugins/native-git/README.md) for reviewer/promoter/sync
connections and [execution](../plugins/execution/README.md) for query/operator
connections.

## Browser and server boundary

The listener binds loopback only. Use an SSH tunnel or a trusted HTTPS proxy
and set `publicOrigin` to its exact public origin. Account roles are explicit:
`read` for queries, `operator` for mutation and `reviewer` for human decisions.
Roles do not imply one another. Each plugin operation advertises its required
role, validates input and bounds its public result. Session roles and CSRF are
checked before dispatch; authoritative services retain their own scope,
generation, review and concurrency checks.

Configuration and connection files are owned mode-0600 regular files; symbolic
links and hard links are rejected. Browser passwords use scrypt. Sessions use
opaque HttpOnly SameSite=Strict cookies, Secure for HTTPS, rotating login,
monotonic idle/absolute expiry, bounded concurrency and bounded guessing.
Host control credentials, executable paths, private connection files and raw
service capabilities never reach the browser. Reviewed plugins can offer an
explicit operator-only read of workspace application credentials, such as an
OpenCode server password; normal status responses exclude these secrets. Console assets use a same-origin CSP,
no-store caching and text-safe rendering.

Tests live under [`tests/web`](../../../tests/web); feature tests live under
[`tests/web/plugins`](../../../tests/web/plugins). The core workspace browser
fixture uses a synthetic CLI and real HTTP authentication; optional feature
fixtures exercise real service protocols independently.
