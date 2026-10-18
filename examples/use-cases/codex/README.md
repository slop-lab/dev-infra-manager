# Codex in a development workspace

Use an ordinary Git source and the optional tool integration. The repository
needs no Codex bootstrap code or DIM manifest:

```sh
dim installer install plugin '@slop-lab/dim-plugin-agent-tools@0.10.0'
dim create https://example.com/team/app.git development
dim tools setup development codex
dim tools run development codex --resume-on-restart
```

Tool setup pins Codex 0.156.1 in the workspace user's persistent home. It does
not log in or copy host operator credentials. Authenticate deliberately using
the tool's own flow. With `--resume-on-restart`, the next workspace start uses
Codex's noninteractive `exec resume --last` adapter against its saved session.
See [agent tools](../../../plugin-agent-tools/README.md) for permission policy,
custom continuation commands and OpenCode's equivalent integration.

For the Codex app's SSH remote mode, configure the ordinary guest SSH adapter
and ProxyCommand described in [workspace SSH](../../../core/packages/core/docs/workspace-client.md#ssh-and-remote-editors).
Its name and API are independent of Codex and work with other remote editors.
No host Docker socket, host private SSH key or DIM operator token enters the
workspace. A separate operator SSH connection carries `dim connect` bytes.

Home and checkout survive stop/start and recreation; discard removes their
owned storage. Use `dim-nproc` to size local test concurrency and
`dim-workspace resources --json` to inspect assigned limits inside the guest.
