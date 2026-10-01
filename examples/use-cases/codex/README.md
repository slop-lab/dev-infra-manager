# Codex in a Project-owned agent workspace

This use case selects Codex for the existing
[`full-development-flow`](../../projects/full-development-flow/README.md)
Project. It changes only the reviewed user-tool selection. The generic agent
image, outer `agent-dind`, inner agent, persistent home, secure daemon, and
`ssh-proxy` task remain unchanged.

Copy [`project-tool.conf`](project-tool.conf) to
`repos/root/.dim/project-tool.conf` before creating the example repositories:

```bash
cp examples/use-cases/codex/project-tool.conf \
  examples/projects/full-development-flow/repos/root/.dim/project-tool.conf
```

Review and commit that Project change, then follow the full-development-flow
creation steps. Install the development helper from one immutable reviewed
development commit exactly as that example documents:

```bash
dim workspace run full-dev tool-setup \
  <workspace-user-setup.bash
dim workspace run full-dev agent --help
```

The helper installs exactly `@openai/codex@0.156.1` under
`$HOME/.local`, verifies the installed package version, and writes the same v1
tool manifest and `$HOME/.local/libexec/dim-project-tool-launch` used by the
OpenCode selection. It neither starts Codex nor performs authentication, and
it does not create or modify `$HOME/.codex/auth.json` or
`$HOME/.codex/config.toml`. Existing persistent-home credentials remain a user
concern. Rerun `tool-setup` explicitly to reconcile the reviewed selection;
workspace lifecycle never installs or upgrades the tool.

The downloaded `workspace-user-setup.bash.sha256` must be verified before the
helper is streamed. The checksum and helper must come from the same full
development commit. No coding-agent package is baked into an image.

For Remote SSH, use the full-development-flow `ProxyCommand` unchanged:

```sshconfig
Host full-dev-agent
    HostName full-dev-agent
    User dim-agent
    RequestTTY no
    ProxyCommand dim workspace run full-dev ssh-proxy
```

Verify each recreated workspace's host-key fingerprint as described by the
base example. Codex is only an OpenSSH client use case; DIM core and the proxy
protocol remain unaware of it.
