# `@slop-lab/dim-web`

Authenticated operations console for local or SSH development hosts and explicit
feature plugins. Ordinary Git hosts need no control plane. Browser accounts
have explicit `read`, `operator`, `reviewer`, and `account-admin` roles. Host selectors, executable
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
replaced. Operators can create workspaces from HTTP(S) or SSH repository URLs (including `git@host:path`) on an explicitly
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

### Task URLs and returning to work

The console is a development workbench. Its native links support opening in a
new tab, reload and browser Back/Forward. Hash routes keep the existing exact
server-path/origin boundary: `#/workspaces`, `#/workspaces/HOST/UUID`, and the
workspace's `/tools`, `/routes` and `/settings` tasks. Creation uses
`#/workspaces/HOST/new`. Hosts are selected for workspace tasks, not inferred as
the authority for every shared service. Installed service tasks live below
`#/features/FEATURE`; the owning plugin defines its object paths.

The requested location remains through login and session expiry. Invalid or
missing destinations explain the problem without selecting a different host or
service. A stopped runtime retains persistent data; recreation replaces only
the runtime, while discard requires explicit confirmation of data loss.
Unavailable hosts allow preparing a draft but pause creation until a successful
host refresh. Tools distinguish OpenCode process state from reachable approved
URLs and expose passwords only after explicit authorized actions.

Forms remain mounted through in-session navigation and refresh. Reload performs
fresh reads and never replays a write; unsaved form input is not persisted to
browser storage. Sign-out and session expiry clear session-owned forms and
results, including credentials. No service secret belongs in a URL. When a
response is uncertain, inspect current authoritative state before retrying.

Stopping or starting a workspace keeps its mounted route drafts and uncertain
tool/route outcomes. Tool controls are marked stale after a runtime change;
**Retry workspace tools** performs an explicit current-state read before enabling
them again. A replacement workspace UUID never inherits the previous workspace's
drafts, results or action authority.

`#/settings` inventories installed Web capabilities, their observed connection
state, and account access. Host-owned VM/KVM, cache/mirror, tailnet/tunnel and
image/shell capabilities have explicit owner guidance, not invented Web setup
controls. `#/settings/access` offers **Manage account & access**, which opens the
single sensitive dialog for the existing role/password-confirmed account-management
flow. Browser roles and service authority remain independent.
On narrow screens the account list becomes labeled rows with all account actions
in view, rather than requiring sideways scrolling inside the dialog.

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
Because reconnect replaces a shared server runtime, it requires the browser
`operator` role. Read-only users are directed to a browser operator instead.
Settings also offers reconnect for workspace-only features. Successful connection
attestation is distinct from a successful workspace read: failed mounts can retry
without remounting healthy siblings or clearing their drafts. Replies crossing a
reconnect boundary cannot reconcile an uncertain write.
The server also fences generations across tabs: an old feature catalog cannot
silently invoke the newly reconnected authority, and a superseded pending result
is reported as unknown rather than mixed with the new service's state.

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
`read` for queries, `operator` for feature mutations, `reviewer` for human decisions,
and `account-admin` for browser account administration.
Roles do not imply one another. Each plugin operation advertises its required
role, validates input and bounds its public result. Session roles and CSRF are
checked before dispatch; authoritative services retain their own scope,
generation, review and concurrency checks.

Configuration and connection files are owned mode-0600 regular files; symbolic
links and hard links are rejected. Browser passwords use scrypt. Sessions use
opaque HttpOnly SameSite=Strict cookies, Secure for HTTPS, rotating login,
monotonic idle/absolute expiry, bounded concurrency and bounded guessing.
Same-origin tabs use only a non-secret `dim.browser-session.epoch` local-storage
marker to fence older session content and delayed credential actions when another
tab signs in or out. Browser storage must permit that marker; credentials and
drafts are never stored there. A self-account change can retain its one-time
receipt until the user continues or a later identity change supersedes it.
Host control credentials, private service connection files and raw service
capabilities never reach the browser. Operators can inspect the trusted local
account-management command and console configuration path in Account & access. Reviewed plugins can offer an
explicit operator-only read of workspace application credentials, such as an
OpenCode server password; normal status responses exclude these secrets. Console assets use a same-origin CSP,
no-store caching and text-safe rendering.

Tests live under [`tests/web`](../../../tests/web); feature tests live under
[`tests/web/plugins`](../../../tests/web/plugins). The core workspace browser
fixture uses a synthetic CLI and real HTTP authentication; optional feature
fixtures exercise real service protocols independently.

## Browser accounts and review access

Open **Account & access** in the console header. An `account-admin` can list,
add or remove accounts, select their roles, and reset passwords directly in the
Web UI. Each change requires the administrator's current password, an authenticated
session, the exact console origin and its CSRF token. No other role grants account
administration. The initial `init-operations` account includes `account-admin`;
`init-features --roles` always uses the explicitly selected roles.

Web changes apply immediately, persist across restarts and preserve service
connections. Role changes, password resets and removal end the affected account's
sessions. If editing your own account, save any generated password before choosing
**Sign in again**. Generated passwords are shown once. The last administrator
cannot be removed or demoted; create another administrator first. Browser account
roles and the Native Git service reviewer identity remain independent: both must
permit a review approval.

Existing installations retain their explicit roles. On the console server, its
configuration owner can bootstrap an existing account through the local CLI:

```sh
dim-web account list
dim-web account set-roles operator --roles read,operator,account-admin
systemctl --user restart dim-web.service
```

Use `--config /absolute/web.json` for a nondefault configuration. Operators without
`account-admin` receive an exact copyable command for their installation. Read-only
users are directed to the console owner. `dim-web account --help` also describes
add, reset-password and remove. CLI changes require a restart and fresh sign-in;
existing passwords are preserved unless explicitly reset. Account commands and
Web updates serialize their own writes; avoid changing the same configuration
with install-local or another editor concurrently.
