# Explicit repository development tasks

This repository uses an ordinary DIM workspace. Its own task script manages
repository dependencies and checks; generic coding-agent installation belongs
to the optional tools plugin.

```sh
dim create /path/on/selected/host/to/dev-infra-manager dev
dim exec dev -- bash scripts/dev.bash setup
dim exec dev -- bash scripts/dev.bash check
dim installer install plugin '@slop-lab/dim-plugin-agent-tools@0.10.0'
dim tools setup dev codex
dim tools run dev codex --resume-on-restart
```

`dim run dev codex` and `dim run dev opencode` execute the installed tool
normally. The `dim-agent` adapter adds explicit session continuation support;
`dim tools run dev TOOL` invokes it on the selected local or SSH host. No
repository-specific agent bootstrap or runtime hooks are required.

For OpenCode's browser UI, set up `opencode`, then run `dim tools server dev`.
It starts only an authenticated loopback backend. The static
[Pages UI](../tools/opencode-web/README.md) connects to its approved HTTPS URL;
its workspace-owned temporary volume stays outside `/tmp` and authentication
configuration. For local access use a separately configured local client
origin rather than weakening the default Pages CORS policy.
