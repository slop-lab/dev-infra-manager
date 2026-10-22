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

The server status shows whether OpenCode is running and the approved external
URLs for its workspace port, when the External routes host plugin is installed.
**Service URL** is the ingress's public service address, including shared
control-plane ingress URLs. A **Permanent URL**, when available, is shown separately
as an additional stable address; it never replaces the service address. Host relay
addresses are never substituted. Stopped servers show
configured URLs without presenting them as running endpoints. Starting a server
does not publish a host port or create a public endpoint.
Copy actions are available for service URLs, permanent URLs and the local
forwarding command, with selectable text when browser clipboard access fails.
Start and Stop controls follow the last observed server state. After an uncertain
mutation, Refresh status must reconcile the outcome before another change.
The status also shows the checkout's actual project directory, with a copy action.
For a managed multi-repository workspace this can be `/workspace/main`, rather than
the `/workspace` directory containing the checkouts. **Open OpenCode Web** opens
the Pages client. Select this workspace's server there, then use **Add project**
with the displayed path. Server selection and authentication remain with that client.
With the optional External routes Web/host plugins, create its port-4096 route
from the same workspace row and approve it explicitly if the ingress requires it.

Operators can explicitly copy the server password or set a new one. Reading the
password requires its own operator operation; status and read-only sessions never
receive it. The browser fetches it only after Copy is selected, with a manual
select-and-copy fallback when the clipboard is unavailable. Password changes use
controller stdin rather than command arguments. Passwords require 12–128 printable
ASCII characters, and changing one restarts a running server. The form clears the
password after submission; passwords are never retained in browser storage.
