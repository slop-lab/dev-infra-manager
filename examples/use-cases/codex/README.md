# Codex in a development workspace

## Runnable recipe

[`recipe.json`](recipe.json) owns the exact host/control-plane plugin selection,
repository paths and executable stages. From the DIM repository root:

```bash
node scripts/examples/run.ts examples/use-cases/codex install-host
node scripts/examples/run.ts examples/use-cases/codex install-control-plane
node scripts/examples/run.ts examples/use-cases/codex verify
```

`verify` is a fast local check using the locked source toolchain; it does not
install plugins or authenticate provider accounts. `dev` runs this directory's
actual setup/service script after the prerequisites below are configured.
For workspace recipes, set `DIM_EXAMPLE_WORK` to a fresh absolute operator
directory; source templates are copied and committed there, never overwritten.

This provider/service recipe has no automatic `verify-vm` stage: its explicit
runtime prerequisites are not silently provisioned by the generic VM journey.
See the [recipe runner](../../README.md) for shared options and the heavy VM gate.

Use an ordinary Git source and the optional tool integration. The repository
needs no Codex bootstrap code or DIM manifest.

Required components: base DIM with Docker/Sysbox and a built workspace image
(`dim image build`), plus `@slop-lab/dim-host-plugin-agent-tools@0.10.0` on the selected
host. Tool installation needs guest network access; inference needs deliberate
guest-side Codex authentication. Managed administration, native Git, CI, an LLM
router and external-URL plugins are not required. For a repository that always
needs these helpers, commit `.dim/workspace.json` containing
`{"plugins":["@slop-lab/dim-host-plugin-agent-tools@0.10.0"]}`. This generic recipe
installs the plugin explicitly instead:


```sh
dim installer install plugin '@slop-lab/dim-host-plugin-agent-tools@0.10.0'
dim create https://example.com/team/app.git development
dim tools setup development codex
dim tools run development codex --resume-on-restart
```

Tool setup pins Codex 0.156.1 in the workspace user's persistent home. It does
not log in or copy host operator credentials. Authenticate deliberately using
the tool's own flow. With `--resume-on-restart`, the next workspace start uses
Codex's noninteractive `exec resume --last` adapter against its saved session.
See [agent tools](../../../packages/host/plugins/agent-tools/README.md) for permission policy,
custom continuation commands and OpenCode's equivalent integration.

For the Codex app's SSH remote mode, configure the ordinary guest SSH adapter
and ProxyCommand described in [workspace SSH](../../../packages/host/core/docs/workspace-client.md#ssh-and-remote-editors).
Its name and API are independent of Codex and work with other remote editors.
No host Docker socket, host private SSH key or DIM operator token enters the
workspace. A separate operator SSH connection carries `dim connect` bytes.

Home and checkout survive stop/start and recreation; discard removes their
owned storage. Use `dim-nproc` to size local test concurrency and
`dim-workspace resources --json` to inspect assigned limits inside the guest.
