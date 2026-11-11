# Coding-agent tools

This optional host plugin owns tool installation and launch behavior. Ordinary
repositories need no `.dim`, OpenCode bootstrap files or DIM-specific scripts.
The base image contains no coding-agent package or provider credentials.

Installing this plugin on the host automatically prepares its small helpers
inside ready workspaces, including ordinary repositories without `.dim` files.
Run `dim-workspace plugins` inside the workspace to discover commands and setup
status. `dim-tools-setup opencode` or `dim-tools-setup codex` performs the explicit
pinned tool installation there; helper preparation itself downloads no tools.

```sh
dim installer install plugin '@slop-lab/dim-host-plugin-agent-tools@0.10.0'
dim tools setup development opencode
# Independently install Codex in the same persistent home:
dim tools setup development codex
dim tools run development codex
```

Setup pins OpenCode 1.18.31, oh-my-openagent 4.19.4 and Codex 0.156.1. The OMO
plugin is loaded from its verified local installation, rather than installing a
second runtime copy. Agent-tools applies an explicit, source-guarded 4.19.4
compatibility patch: initial default selection and foreground/background retries
retain the upstream role chains and variants but skip provider/model pairs absent
from the authenticated catalog. A connected provider alone does not prove access
to every model it advertises elsewhere. Explicit operator model overrides remain
operator choices; missing models are never renamed to another model family.

Before starting an agent or Web server, the helper runs the pinned OpenCode
`models --verbose` command with the current provider integrations and launch
environment. This refreshes OMO's private inventory, including metadata, before
OMO selects defaults, including on a fresh installation. It starts no agent
session. Inventory discovery failure stops launch with an error. This patch must
be revalidated or removed when changing the OMO pin; changed source is rejected.

OMO team
mode is configured in the user's home; reviewed repository-specific tool
settings remain in the repository. OpenCode/OMO setup adds `.omo/` to the
workspace user's global Git ignore file, preserving existing entries and a
configured `core.excludesFile` path. Provider authentication is an explicit
user action. Setup neither logs in nor copies credentials from the DIM host.
`dim tools setup` works on the selected local or SSH host and streams its
progress through the normal workspace transport.

Workspace-backed monitoring reads fresh, bounded OMO team metadata through
`dim tools console invoke server.team-metadata --input '{"workspace":"development","workspaceId":"EXACT_UUID"}' --json`.
This read-only operation binds the current workspace UUID and helper-owned
OpenCode PID, birth identity, instance and working directory. It emits only
session IDs, statuses and modification times, never config, environment,
authentication, prompts or tool payloads. It installs nothing and does not call
OMO's cleanup-capable team-list API.

Automatic discovery supports the pinned 4.19.4 DIM-managed user configuration
and its absolute or `~/` team `base_dir` override. It validates ownership and
rejects symlinks, oversized or changing files. A missing runtime directory is
empty evidence only after establishing the owned configured base. Selected
profiles, project overrides, unsupported user configuration, settings differing
from the owned server launch hash, or unreadable state remain unavailable.
Advanced setups can supply the monitor's explicit reviewed metadata adapter.
Already-running servers launched before this capability have no hash and remain
unavailable; monitoring does not restart them. The reader does not
implement a second OMO configuration engine or turn unknown discovery into idle.
A monitor's optional `directory` input is transported through bounded stdin and
must equal the actual server directory. Workspace-backed monitoring supplies it
automatically; nested selections needing a different configuration context
require the appropriate server or an explicit reviewed adapter.

## Execution status and bounded change waiting

Agent-tools owns coding-agent observation. Host core's workspace agent remains
the generic scoped service bridge, not a coding-agent scheduler. The OpenCode
adapter reuses the bounded task-tree monitor: it reads the owned server's
authenticated API, subagent relationships and optional OMO metadata. Credentials
stay in the guest and never appear in status, arguments or evidence. Inspection
does not deploy helpers, start a server, submit a message or stop a task.

From the workspace, use the existing plugin-operation boundary:

```sh
dim-workspace plugin agent-tools execution-status '{"sessionId":"ses_REVIEWED"}'
dim-agent-execution status --session ses_REVIEWED
dim-agent-execution wait --session ses_REVIEWED --timeout-seconds 120 --json
```

The selected-host console exposes the same snapshot, with immutable workspace
identity, and a bounded wait:

```sh
dim tools console invoke execution.status --input '{"workspace":"development","workspaceId":"EXACT_UUID","sessionId":"ses_REVIEWED"}' --json
dim tools console invoke execution.wait --input '{"workspace":"development","workspaceId":"EXACT_UUID","sessionId":"ses_REVIEWED","timeoutSeconds":120}'
```

Status returns `evidence` and a SHA-256 `revision`. The guest one-shot operation
returns the evidence directly. Wait optionally accepts `since` (or local
`--since`) from an earlier revision and returns `changed` or `timed-out`, with
the latest evidence and observation count. With no revision it takes an initial
snapshot, then waits for a semantic change. A deadline before any successful
observation returns null evidence/revision, never fabricated idle evidence.
Human output is one concise summary; `--json` retains sanitized machine data.

Wait has one absolute deadline of at most 180 seconds, at most three snapshots
and at least 60 seconds between snapshots. Each OpenCode snapshot is capped at
16 sessions, depth 8, 48 API requests, four recent messages per session and ten
seconds; a complete wait therefore permits at most 144 API requests. HTTP
responses and guest output have independent byte bounds. Request counts,
observation timestamps and metadata modification times do not change the
revision. Cancellation aborts only observation, not the underlying task. Long
waiting belongs to the host console or local helper, not the guest bridge's
15-second request transport. Coordinators should call wait rather than polling
status more often than once per minute.

Known busy children keep the aggregate active even when their parent is idle.
Unknown/truncated team discovery remains explicit; active-child counts are a
lower bound when total discovery is unknown. Empty `teams` never establishes
idle when team metadata is unavailable. Conflicting API/OMO state is retained
and cannot establish idle. Waiting questions/permissions are counted without
their payloads. Completion is always `not-assessed`, not task acceptance.

Discovery advertises `coding-agent-execution-status` only when the reviewed
adapter is present; absent installed helpers remain blocked without automatic
repair. It separately reports `coding-agent-task-submission` as unavailable,
reason `no-task-producer`. DIM currently has no typed task-message submission
operation. A direct OpenCode adapter can deliver a task under its own authority,
but that is not a DIM task API. Submission/correlation and authorization belong
to an explicit future agent-tools producer adapter, not the workspace bridge,
CI scheduler or a new policy engine.

Installed metadata returning `source: "unavailable"`, `enabled: null`,
`unreadable: true`, `teams: []` remains real negative evidence even when main
sessions run and OpenCode's `team_list` succeeds. These observations do not
establish team idleness or diagnose the installed configuration. This status
interface preserves that distinction rather than manufacturing metadata.

The optional `@slop-lab/dim-web-plugin-agent-tools` package adds a **Workspace
tools** section in each DIM Web workspace management row. It discovers this host plugin automatically through
configured controllers. Open a running workspace's tools to inspect or explicitly
install OpenCode/Codex and start, inspect or stop its OpenCode server. Mutations
require an operator Web session; every request binds the workspace's current ID.
No repository configuration or extra control-plane connection is required.
The Web view shows and copies the actual checkout directory for OpenCode Web;
a multi-repository workspace may use `/workspace/main` rather than `/workspace`.
Its Open OpenCode Web link passes only the approved endpoint and this guest path
to the pinned client, which reuses server/project registrations. Required server
authentication stays in OpenCode; DIM does not copy credentials into this link.

On Alpine/musl workspaces, explicit OpenCode setup or launch installs `gcompat`
through the workspace package manager when needed, and applies it only to the
OpenCode process environment. The pinned OpenCode embeds a glibc PTY library
that otherwise fails to load even when its HTTP health endpoint is healthy.
Helper discovery and status inspection do not install system packages.

## Continue after restart

Opt in when launching the tool:

```sh
dim tools run development codex --resume-on-restart
# Or:
dim tools run development opencode --resume-on-restart
```

The installed `dim-agent` registers a user-owned command with the generic
`dim-workspace session` facility. After restart or recreation the workspace
starts that command in the same checkout. Codex uses `exec resume --last`;
OpenCode uses `run --continue`. Each receives an explicit continuation prompt.
Tool authentication, history and configuration stay in the persistent home.
The initial invocation can be interactive; automatic continuation is a
noninteractive process. Configure the tool's own permission policy for that
mode. DIM does not silently enable unrestricted tool permissions.

Inside the workspace, inspect the allocation and restart without learning a
host-admin credential:

```sh
dim-workspace resources --json
dim-nproc
dim-workspace restart
# To stop continuing on future starts:
dim-workspace session clear
```

One registered command owns automatic continuation. Registering another tool
replaces it deliberately. Initial tool flags are passed unchanged; automatic
continuation reads the tool's persisted configuration. For an exact custom
continuation command, use `dim-workspace session register -- COMMAND...`.

## OpenCode server and web client

```sh
dim tools server development
# Inspect or stop only the server owned by this helper:
dim tools server development status --json
dim tools server development stop --json
```

Starting the server registers an agent-tools-owned foreground service with the
existing workspace service registry. Workspace starts and container recreation
resume that service with the same private credentials, saved public port/CORS
settings and retained OpenCode session data. Explicit stop removes its automatic
start intent. A project service occupying the reserved name is rejected without
replacement. No tools are installed automatically. The host plugin also converges only its
existing owned registration after the workspace channel is ready; this recovers
an early boot attempt without restoring intent removed by an explicit stop.
Named guest `dim-workspace service resume NAME` resumes only that registration;
boot's unnamed form continues to resume all explicitly registered services.

Only `opencode serve` runs in the workspace, bound to its loopback port 4096.
The launcher creates private Basic credentials, preserves the same password
across launches, verifies listener ownership before reuse and does not stop
unrelated processes. OpenCode temporary work is under
`$DIM_WORKSPACE_TMPDIR/opencode` on the separate workspace-owned temporary
volume; outside a DIM runtime it uses `$HOME/.local/tmp/opencode`.

Inside the workspace, request its stable, workspace-scoped service name:

```sh
dim-expose --name opencode --port 4096 --ingress YOUR_HTTPS_INGRESS
dim-expose list
```

A host operator must approve a pending route. DIM Web's workspace button opens
that approved service URL and the actual checkout automatically in the client.
For a manually opened client, enter the approved HTTPS URL in its server selector at
`https://slop-lab.github.io/dev-infra-manager/opencode-web/`. Passwords are not
printed in launcher output; read the indicated private credentials file only
when connecting your own client. The default CORS origin is exactly
`https://slop-lab.github.io`, without a repository path. Extra exact origins
can be configured through `OPENCODE_WEB_CORS_ORIGINS`; wildcards are rejected.
See [the Pages build](../../../../tools/opencode-web/README.md) and the
[agent URL skill](../external-urls/skills/external-urls/SKILL.md).

The maintained setup derives from the user's
[OpenCode setup gist](https://gist.github.com/mjy9088/d272d2955cc0b0aa8f90391e9bec91e5).
It keeps the useful user-home/OMO setup while replacing broad process killing,
automatic unauthenticated exposure and repository bootstrap with explicit
workspace operations.

When the optional LLM-router plugin attaches a workspace, these helpers run its
user-side OpenCode launch hook before TUI/run/server/saved continuation. That
hook returns only OpenCode configuration and an OMO profile selection; tools do
not load host plugins or upstream credentials. Existing owned Web servers are
restarted when router, OMO, or OpenCode configuration changes and reused when
unchanged. Run `dim tools server WORKSPACE` again after attachment/token rotation
to refresh an existing server. `DIM_LLM_ROUTER_OPENCODE_MODE=providers` explicitly
retains independent model/provider choices.

An attached router may supply a guest-side readiness hook. Explicit server
startup/reuse validates the loaded provider routing and configured primary agent
against the real OpenCode API, rather than treating HTTP health as sufficient.
Only an owned stale server is restarted; role/model configuration, Web credentials
and sessions are retained. Read-only tools console status and credential reads
do not deploy helpers, evaluate launch hooks or install tools, so optional task
monitoring cannot overwrite an existing guest adapter merely by inspecting it.

OpenCode's runtime npm installs use the same private, user-owned npm cache as
setup, including TUI/run/server and saved continuation. This avoids older images'
root-owned `~/.npm` cache without changing its ownership or contents. An explicit
`NPM_CONFIG_CACHE` or `npm_config_cache` is retained when it names an absolute,
owned directory without a symlink. Changing this cache selection refreshes an
owned server on the next `dim tools server` invocation.

OpenCode credentials can be read explicitly by an operator using the
`server.credentials` console operation. The `server.password` operation takes
`{workspace, workspaceId, password}` through `--input-stdin` only; the password
never belongs in process arguments. Passwords contain 12–128 printable ASCII
characters, including spaces and punctuation. Status and mutation responses
exclude passwords. Updating the password restarts only the identified owned
running server and verifies its authenticated health; setting it before launch
preserves stopped state. Credentials remain private in the workspace home across
stop and restart.
