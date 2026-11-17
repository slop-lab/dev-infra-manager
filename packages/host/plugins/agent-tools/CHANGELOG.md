# Coding-agent tools changelog

## Unreleased

Target: `0.10.0` internal development candidate.

- Install three pinned context/efficiency tools during explicit OpenCode
  setup: context-mode 2.2.0 (plugin by exact file URL), caveman 4.1.0
  (commit-verified clone, non-interactive `--only opencode` payload only) and
  serena-agent 2.1.0 (checksum-verified pinned uv, registered as the `serena`
  local MCP server). Caveman's routing CLI, MCP-shrink middleware and
  interactive agent/login discovery are not installed.
- Prepare small coding-agent helpers automatically from the installed host
  plugin, independently of repository configuration. Discover commands and
  tool setup state from inside the workspace; install selected pinned tools
  explicitly without copying host credentials. Shared guest delivery repairs
  helper files and preserves unchanged assets.
