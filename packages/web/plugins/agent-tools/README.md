# Workspace tools for DIM Web

This optional Web plugin discovers the `agent-tools` host plugin through the
Web server's selected controllers. It appears inside each workspace's management
row, using that row's exact identity without a separate tab or selector. It checks installed
OpenCode and Codex tools, explicitly installs them, and starts, inspects or stops
the workspace's managed OpenCode server.

The plugin never accepts executable paths, shell commands, arbitrary server
options or private connection files from the browser. Every action is scoped to
a selected controller and the current workspace identity. Read-only sessions can
inspect tools and server status; setup and server changes require operator access.

OpenCode server connection guidance contains no credentials. The server remains
inside the workspace boundary; starting it does not publish a host port or create
a public endpoint. Use the workspace's configured network exposure to connect.
With the optional External routes Web/host plugins, create its port-4096 route
from the same workspace row and approve it explicitly if the ingress requires it.
