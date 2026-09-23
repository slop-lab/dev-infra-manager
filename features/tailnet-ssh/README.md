# Example: Tailnet SSH

This opt-in feature exposes an SSH server in the Project runtime through one
raw TCP listener on the DIM host's existing Tailscale address:

```text
tailnet client -> DIM host 100.64.0.0/10:49152 -> workspace relay -> ssh:22
```

Only the host is a tailnet node. The workspace and `ssh` container receive no
Tailscale binary, state, socket, auth key, or LocalAPI access. DIM runs only
`tailscale status --json`, verifies that the daemon reports `Running`, selects
the host's current CGNAT self address, and binds that exact address. It never
runs `tailscale up`, Serve, or Funnel.

The `tailscale` ingress driver is included in
`@slop-lab/dim-plugin-external-urls`; it remains dormant until an ingress using
that driver is configured. The host prerequisites are a separately installed,
already authenticated Tailscale CLI/daemon and a tailnet policy that allows the
chosen client to reach TCP port 49152. No Tailscale package is a DIM core
dependency.

## Run the example

Install and explicitly enable the External URLs plugin at DIM's exact version:

```bash
npx '@slop-lab/dim-installer@0.9.0' install-plugin \
  '@slop-lab/dim-plugin-external-urls@0.9.0'
dim plugin list
```

Choose the public key for the non-root `developer` account, then materialize
and register the Project:

```bash
export DIM_TAILNET_SSH_PUBLIC_KEY_FILE="$HOME/.ssh/id_ed25519.pub"
bash create-repository.bash
bash register-project.bash
bash configure-ingress.bash
dim workspace create tailnet-ssh tailnet-ssh-dev --profile development
```

The create script validates and commits only the public key into the disposable
example repository. The private key remains on the client. The checked-in key
is synthetic documentation data and is always replaced by the create script.

Workspace setup starts the nested SSH container without publishing a Docker
host port, waits for its health check, and idempotently requests the fixed
`tailnet-ssh` ingress with target `containers=["ssh"]`, TCP port 22. Read the
returned `tcp://ADDRESS:PORT` endpoint and connect as the non-root user:

```bash
ssh -i "$HOME/.ssh/id_ed25519" -p 49152 developer@100.100.10.20
```

The image generates server host keys on first start in a Project-owned Docker
volume and authorizes only the selected public key. Password and root login are
disabled. Recreating the workspace route reuses the same ingress target;
another workspace or target cannot claim the listener until the route is
revoked. Discarding the workspace revokes its claim.

This feature is not part of the default examples and does not configure or
authenticate Tailscale. For isolated CI without a real tailnet, use
`verification/scripts/headscale-tailnet-tcp-smoke.bash`.
