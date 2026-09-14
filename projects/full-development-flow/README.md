# Full development flow

This reference Project combines the DIM features that normally belong in one
long-lived development environment:

- a protected root repository plus reviewed `web` and `secrets` repositories;
- a persistent, unprivileged agent home and private rootless Docker daemon;
- host-provided Git author identity and constrained managed-Git credentials;
- an agent controller proxy that permits only an asynchronous self-restart;
- an optional `documentation` Compose profile;
- Project-owned `backup`, `restore`, `bash`, `ssh-proxy`, `codex`, and `claude`
  tasks; and
- a trusted, separately deployed secret-bearing service outside the agent's
  private container daemon.

It intentionally contains no DIM CI-runner, registry-cache, failure-injection,
or provider-specific configuration. Those are host or verification concerns.

## Create and register

```bash
bash examples/projects/full-development-flow/create-repositories.bash \
  "$PWD/full-development-repositories"

bash examples/projects/full-development-flow/register-project.bash \
  full-development "$PWD/full-development-repositories"
```

The generated root manifest protects `main`. Review changes into the managed
root before restarting or updating a workspace.

## Work persistently

```bash
dim workspace create full-development full-dev \
  --profile documentation \
  --cpus 4 --memory 8g --pids 2048

dim workspace run full-dev bash
dim workspace run full-dev codex
dim workspace stop full-dev
dim workspace start full-dev
```

The agent can use its private Docker daemon but cannot access a host Docker
socket or the trusted secret service's raw environment.

## Connect with OpenSSH

The generic `ssh-proxy` task carries an unmodified SSH byte stream to the
agent's internal port 22. It accepts no arguments and never allocates a TTY.
The Compose service does not publish an SSH port or socket on the host.

Provision a public key through the existing `bash` task. The key is stored in
the persistent agent home; no key is built into the image:

```bash
dim workspace run full-dev bash -- -lc \
  'umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; \
   chmod 0700 ~/.ssh; chmod 0600 ~/.ssh/authorized_keys; \
   cat >>~/.ssh/authorized_keys' \
  <~/.ssh/id_ed25519.pub
```

The SSH account is `dim-agent`, with passwd home `/home/dim-agent` and the same
numeric UID/GID as the workspace owner. Root login, passwords, empty
passwords, and keyboard-interactive authentication are disabled. Only public
keys in `/home/dim-agent/.ssh/authorized_keys` are accepted.

Before accepting a host key, obtain the server's trusted Ed25519 fingerprint
through the existing Project task path:

```bash
dim workspace run full-dev bash -- -lc \
  'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'
```

Compare that value with the fingerprint shown by the OpenSSH client. Do not
disable strict host-key checking. Configure the client with a `ProxyCommand`:

```sshconfig
Host full-dev-agent
    HostName full-dev-agent
    User dim-agent
    RequestTTY no
    ProxyCommand dim workspace run full-dev ssh-proxy
```

Connect with `ssh full-dev-agent`. Standard OpenSSH features that operate over
this transport can support shells, editors, file transfer, and Codex Remote
SSH workflows; Codex is a use case, not part of the proxy protocol.

`dim workspace stop` preserves the named agent-home volume. A subsequent
`dim workspace start` reruns setup, which recreates the agent container and
generates new host keys; verify the new fingerprint before reconnecting. The
volume, including `authorized_keys`, survives that recreation. `backup`
includes the complete agent home, and `restore` restores its authorized keys,
but runtime host keys are neither persistent nor backed up. Discarding the
workspace removes the volume, so save a backup first when authorized keys must
survive discard and recreation.

The proxy itself provides no authentication or authorization. OpenSSH and the
agent-controlled `authorized_keys` file provide those controls. A trusted key
receives the same unprivileged `dim-agent` authority as Project tasks,
including access to the workspace, persistent home, private rootless Docker
daemon, and restricted controller proxy. It does not grant container-root
login, publish a network listener, expose a raw host Docker or controller
socket, or create a boundary against other processes already controlling the
agent account.

## Backup before recreation

```bash
dim workspace run full-dev backup >full-dev-home.tar.gz
gzip -t full-dev-home.tar.gz

dim workspace discard full-dev --yes
dim workspace create full-development full-dev --profile documentation
dim workspace run full-dev restore <full-dev-home.tar.gz
```

`backup` and `restore` stream only the Project-owned agent-home volume. Git
work must be committed and pushed separately before discarding a workspace.

## Trusted deployment

After reviewing the root and `secrets` repositories, a trusted host may deploy
the secret-bearing service beside the Project-owned environment:

```bash
EXAMPLE_SECRET=replace-me \
  bash examples/projects/full-development-flow/deploy-secret.bash full-dev
```

See `verification/scripts/stateful-development-flow-smoke.bash` for the disposable
end-to-end release journey. It materializes this example and injects failures
only into its temporary copy.
