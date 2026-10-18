# Inside a workspace

The image provides `dim-workspace` and `dim-nproc`. They work against the current
workspace only, independently of its runtime backend. The host writes a private
connection into `~/.config/dim/workspace.json`; do not copy it to another
workspace or expose it through an application server.

```sh
dim-workspace resources --json
dim-nproc
dim-workspace restart
dim-workspace recreate
```

Resource values describe the assigned CPU, memory and PID limits. Fractional
CPU allocations round down for test concurrency, with a minimum of one worker.
For unlimited CPU, `dim-nproc` uses the guest's process affinity and any local
cgroup v2 quota. A VM may have fewer visible vCPUs than its host; nothing in
this interface exposes host administration.

Optional plugins can receive an explicitly scoped request, such as a URL:

```sh
dim-workspace expose --name app --port 3000 --ingress YOUR_INGRESS
dim-workspace urls --json
```

That request cannot choose another workspace, Docker socket or host upstream.
An ingress that requires approval remains unavailable until a host operator
approves it. The guest cannot perform approval.

## Continue a process after restart

Register the exact executable and arguments, without a shell expression:

```sh
dim-workspace session register -- my-tool resume --last
```

DIM saves the argv and current working directory privately in
`~/.local/state/dim/session.json`. Workspace startup runs `session resume`
after its runtime is ready. Home and checkout persist through recreation, so
tool-owned state remains available. The process has ordinary workspace
permissions, no host API credentials. Registered processes must support
noninteractive startup. DIM does not interpret their sessions or invent tool
arguments. Optional tool integrations own those adapters.

`dim-workspace session clear` stops automatic launch on subsequent starts; it
does not kill an already running tool. There is one registered command per
workspace. Registering another replaces the previous command.

## SSH and remote editors

SSH is an explicit guest service. It listens only on guest loopback port 2222
and travels through the same authenticated `dim connect` transport. Enable it
using your **public** SSH key, from the host/client:

```sh
cat ~/.ssh/id_ed25519.pub | dim exec development -- dim-workspace-ssh setup
dim exec development -- dim-workspace-ssh host-key
```

Setup creates a persistent guest host key and a private authorized-keys file.
It disables password login, root login and remote port forwarding. Local
forwarding to guest loopback is available for remote-editor server processes.
The guest's initially locked account receives an unrecorded random password
solely to allow public-key login; the SSH server never permits password auth.

Add an SSH entry on your client:

```sshconfig
Host dim-development
    User dim
    HostName development
    Port 2222
    ProxyCommand dim --host devbox connect development 2222
    HostKeyAlias dim-development
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    StrictHostKeyChecking yes
```

Verify the host key printed by the setup command, then add it under the
`dim-development` alias to your SSH known-hosts file. Do not disable host-key
verification. `ssh dim-development` now runs inside the workspace; the host
SSH account is still used only by DIM's transport. Remote editors, including
Codex's SSH remote feature, can use this same ordinary SSH entry.

The enabled service restarts with its workspace and preserves its key through
recreation. A discarded/replaced workspace gets a different key and requires
an explicit known-host update. `dim-workspace-ssh stop` stops the current guest
listener; remove `~/.config/dim/ssh-enabled` as well to disable future starts.
