# Workspace tunnels

Optional host plugin `@slop-lab/dim-host-plugin-tunnels` connects workspace-local TCP
and UDP ports to fixed services chosen by the operator. It needs the base DIM
workspace service; it does not need a control plane or managed controller.

```sh
dim installer install plugin @slop-lab/dim-host-plugin-tunnels@0.10.0
dim tunnel prepare --config /home/operator/.config/dim/tunnels.json
dim tunnel add --config /home/operator/.config/dim/tunnels.json \
  --name database --protocol tcp --target-host database.internal --target-port 5432
dim tunnel add --config /home/operator/.config/dim/tunnels.json \
  --name dns --protocol udp --target-host 192.0.2.53 --target-port 53
dim tunnel serve --config /home/operator/.config/dim/tunnels.json \
  --listen 10.0.0.1 --port 8742 --ui-port 8743
```

Use a private host address reachable from the workspace for `--listen` and
`--endpoint`. TCP and UDP use the same relay port. This protocol authenticates
workspace access; it does not encrypt network traffic. Keep it on a trusted
private network or an encrypted operator-provided network. The management UI
always binds host loopback. Forward it over operator SSH if the DIM host is
remote, then open `http://127.0.0.1:8743`. Its Basic-auth username and generated
password are stored only in the private configuration file.

The UI adds/removes routes and revokes individual workspace grants. Mutations
require JSON and reject a foreign browser Origin. CLI equivalents:

```sh
dim tunnel list --config /home/operator/.config/dim/tunnels.json
dim tunnel remove --config /home/operator/.config/dim/tunnels.json --name database
dim tunnel attach dev --config /home/operator/.config/dim/tunnels.json \
  --route database --endpoint 10.0.0.1:8742 --local-port 5432
dim tunnel attach dev --config /home/operator/.config/dim/tunnels.json \
  --route dns --endpoint 10.0.0.1:8742 --local-port 5353
```

Inside `dev`, connect to `127.0.0.1:5432` or send UDP to `127.0.0.1:5353`.
The guest receives one opaque credential per route and workspace UUID, never
the operator password or a host control socket. It cannot choose other targets.
All attached tunnels share one endpoint and run under the independent
`dim-workspace service` registry. They resume after workspace restart/recreate;
the coding-agent session remains separate. The guest configuration lives at
`~/.config/dim/tunnels.json`; logs are in `~/.local/state/dim/services/tunnels.log`.
To stop all guest listeners, run `dim-workspace service remove tunnels`.
Re-attaching a route rotates that workspace's credential.

Each TCP connection and UDP request checks the current grant and running
workspace UUID. Reusing a display name or an IP address cannot adopt an old
grant. Active connections close when periodic reconciliation observes revocation or
workspace disappearance; checks run every 500 ms when the preceding workspace
checks have finished. Existing UDP peer mappings expire
after 30 seconds of inactivity. Definitions and grants survive relay restart;
clients reconnect TCP sessions normally. The plugin does not promise to retain
an already-open TCP stream through a relay restart.
