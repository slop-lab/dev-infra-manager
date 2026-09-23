# @slop-lab/dim-cli

Local approval and execution client for DIM. Pin the exact reviewed release:

```bash
npm install --global --save-exact @slop-lab/dim-cli@0.9.0
dim approve --config ~/.config/dim/local.json reviewed-approval.json
dim run-remote --config ~/.config/dim/local.json --request-id request-1 project-1
```

The local schema-1 configuration names absolute approval, private-key, and
pinned-known-host paths plus a map from workload IDs to local commands. Remote
proposals can select only those IDs. SSH forwarding, agent use, PTYs, local
commands, interactive authentication, and host-key discovery are disabled.

Provider-specific Gitea and CI code is not installed transitively. Install
`@slop-lab/dim-control-plane` separately on the remote host when needed.
