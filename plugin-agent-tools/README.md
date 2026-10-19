# Coding-agent tools

This optional host plugin owns tool installation and launch behavior. Ordinary
repositories need no `.dim`, OpenCode bootstrap files or DIM-specific scripts.
The base image contains no coding-agent package or provider credentials.

```sh
dim installer install plugin '@slop-lab/dim-plugin-agent-tools@0.10.0'
dim tools setup development opencode
# Independently install Codex in the same persistent home:
dim tools setup development codex
dim tools run development codex
```

Setup pins OpenCode 1.18.31, oh-my-openagent 4.19.4 and Codex 0.156.1. OMO team
mode is configured in the user's home; reviewed repository-specific tool
settings remain in the repository. Provider authentication is an explicit
user action. Setup neither logs in nor copies credentials from the DIM host.
`dim tools setup` works on the selected local or SSH host and streams its
progress through the normal workspace transport.

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
```

Only `opencode serve` runs in the workspace, bound to its loopback port 4096.
The launcher creates private Basic credentials, preserves the same password
across launches, verifies listener ownership before reuse and does not stop
unrelated processes. OpenCode temporary work is under
`$DIM_WORKSPACE_TMPDIR/opencode` on the separate workspace-owned temporary
volume; outside a DIM runtime it uses `$HOME/.local/tmp/opencode`.

Inside the workspace, request its stable, workspace-scoped service name:

```sh
dim-workspace expose --name opencode --port 4096 --ingress YOUR_HTTPS_INGRESS
dim-workspace urls --json
```

A host operator must approve a pending route. Enter that approved HTTPS URL
and the workspace user's OpenCode credentials into the server selector at
`https://slop-lab.github.io/dev-infra-manager/opencode-web/`. Passwords are not
printed in launcher output; read the indicated private credentials file only
when connecting your own client. The default CORS origin is exactly
`https://slop-lab.github.io`, without a repository path. Extra exact origins
can be configured through `OPENCODE_WEB_CORS_ORIGINS`; wildcards are rejected.
See [the Pages build](../tools/opencode-web/README.md) and the
[agent URL skill](../plugin-external-urls/skills/external-urls/SKILL.md).

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
