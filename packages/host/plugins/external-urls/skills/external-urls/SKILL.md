---
name: dim-external-urls
description: Expose a workspace HTTP service through an approved DIM ingress and inspect its workspace-scoped URL without host administration credentials.
---

Use this skill when an agent running inside a DIM workspace needs a browser
URL for its own development service.

Run `dim-workspace plugins` to discover the installed integration and its
readiness. The host prepares `dim-expose`; the source repository needs no DIM
configuration. Ingress names and approval remain host choices.

1. Start the service bound to `127.0.0.1` inside the workspace. Keep its process
   alive. Choose the actual service port and a stable service name, such as
   `app` or `opencode`. Do not put credentials into the service name or URL.
2. Request a route using the configured ingress name:

   ```sh
   dim-expose --name app --port 3000 --ingress YOUR_INGRESS
   dim-expose list
   ```

3. Read the returned route ID, URL and approval status. A pending route is
   unavailable until the host operator approves it. Report the route ID and
   this host-side command to that operator:

   ```sh
   dim external-url approve ROUTE_ID
   ```

4. Once approved, verify the URL with an ordinary HTTP request. If authentication
   is part of the service, keep its private credentials out of logs, issue text
   and public links. Browser clients hosted on HTTPS need an HTTPS backend;
   configure the service's exact allowed browser origin when required.

The workspace API is already scoped to this workspace's immutable identity.
Do not select a different workspace, host socket or host address. Do not mount
host Docker sockets or copy DIM operator tokens into a nested container.
Do not attempt approval from the workspace. If the optional URL plugin or
specified ingress is absent, report the error and ask the operator to configure
it; do not invent a public endpoint.

Names stay stable within a workspace. Restart/recreation preserves its identity
and data; discard and name reuse creates a new identity and requires a fresh
route and approval. An existing URL must never be treated as authority to
access a replacement workspace.

For local-only browser access without a public ingress, the operator can run
`dim forward WORKSPACE 3000:3000`. That port belongs to the operator's machine,
not automatically to the browser user's device.
