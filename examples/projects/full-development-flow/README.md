# Full development flow

This reference Project combines the DIM features that normally belong in one
long-lived development environment:

- a protected root repository plus reviewed `web` and `secrets` repositories;
- a persistent, unprivileged agent home and an agent launched inside its
  private rootless Docker daemon;
- host-provided Git author identity and constrained managed-Git credentials;
- an agent controller proxy that permits only an asynchronous self-restart;
- an optional `documentation` profile launched inside the agent daemon;
- Project-owned `backup`, `restore`, `bash`, `tool-setup`, `agent`, and `ssh-proxy`
  tasks; and
- an optional `secure` daemon that launches the reviewed secret-bearing
  service outside the agent's private container daemon.

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
dim workspace stop full-dev
dim workspace start full-dev
```

The trusted outer Compose graph contains only `agent-dind` and the optional
`secure-dind`. The actual agent and documentation preview run inside
`agent-dind`; the secret service runs inside `secure-dind`. The agent can use
its private daemon's Unix socket but cannot access a host, trusted-workspace,
or secure daemon socket, or the secret service's raw environment.
Both private daemons start `dockerd` with only that explicit Unix listener;
the upstream image's empty-argument TCP fallback is not used. Stored profiles
are authoritative on every setup: removing `secure` stops its outer daemon,
and removing `documentation` removes the restart-enabled preview from the
persistent agent daemon.
On first use, `agent-dind` gives the empty named home root to its mapped
mapped inner agent identity with mode `0700`; a populated root with incompatible
ownership or mode fails closed. Inner startup changes only that top-level
directory to `dim-agent` and preserves descendant ownership and modes. The
Project task and OpenSSH identities remain the workspace owner's nonroot
UID/GID.
Ordinary agent tasks run as the workspace owner's nonroot identity and may use
passwordless `sudo` only for root inside the agent container, without gaining
trusted-workspace or host runtime authority.
The agent's `TMPDIR` is `/tmp/opencode`, backed by a separate
`dim-agent-tmp` volume inside the private daemon. It is owned by the agent with
mode `0700`, survives agent-container recreation, and is not part of the
persistent home or its backup. Setup rejects a symlink or a populated root with
incompatible ownership or mode. Ordinary workspace discard removes this exact
owned volume; `--keep-volume` retains it with the private daemon store.

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

For a client on a different machine, use a host-scoped OpenSSH alias instead.
Here `remote-main` is an independently configured SSH connection to the DIM
host, and the host runs its own `dim` CLI. The pattern names only aliases for
this **one** workspace on this **one** host:

```sshconfig
Host host-name-*
    HostName dim-agent
    HostKeyAlias dim-agent-remote-main
    User dim-agent
    RequestTTY no
    ProxyCommand ssh -T remote-main dim workspace run full-dev ssh-proxy
```

Connect with `ssh host-name-full-dev` or select that alias in an editor's
Remote SSH picker. The outer `ssh -T remote-main` authenticates to the DIM host;
the inner SSH client separately authenticates to `dim-agent` over the byte
stream. Check the agent host-key fingerprint above before accepting it. The
fixed `HostKeyAlias` keeps all aliases for this workspace under one known-host
identity; after agent recreation, verify the new fingerprint before replacing
that known-host entry. For another DIM host or workspace, use a separate,
non-overlapping `Host` pattern with its own fixed remote host, workspace name,
and host-key alias. Do not interpolate an untrusted SSH hostname into a shell
command or disable host-key checking to share this pattern.

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

## Install user tooling and launch Web

The generic agent image does not embed a coding-agent CLI. To install the
shared user tooling from an immutable, reviewed development revision, replace
the commit placeholder and set `DIM_DEVELOPMENT_RAW_ROOT` to the raw-file root
for the reviewed development repository, ending before the commit and file
path. An optional trailing slash is normalized. Download the script and its
checksum from the same revision, then verify it on the host before streaming
it into the agent. Optionally set `OPENCODE_WEB_CORS_ORIGINS` on the host to a
JSON array of additional trusted client UI origins; unset uses the default:

```bash
(
  set -euo pipefail
  FULL_DEVELOPMENT_COMMIT='<FULL_DEVELOPMENT_COMMIT>'
  [[ "$FULL_DEVELOPMENT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'FULL_DEVELOPMENT_COMMIT must be exactly 40 lowercase hex characters\n' >&2
    exit 2
  }
  setup_dir="$(mktemp -d)"
  trap 'rm -rf -- "$setup_dir"' EXIT
  : "${DIM_DEVELOPMENT_RAW_ROOT:?set the development repository raw-file root}"
  development_raw_root="${DIM_DEVELOPMENT_RAW_ROOT%/}"
  base="${development_raw_root}/${FULL_DEVELOPMENT_COMMIT}/scripts"
  curl --fail --silent --show-error --location \
    --output "$setup_dir/workspace-user-setup.bash" \
    "$base/workspace-user-setup.bash"
  curl --fail --silent --show-error --location \
    --output "$setup_dir/workspace-user-setup.bash.sha256" \
    "$base/workspace-user-setup.bash.sha256"
  curl --fail --silent --show-error --location \
    --output "$setup_dir/opencode-web.bash" \
    "$base/opencode-web.bash"
  curl --fail --silent --show-error --location \
    --output "$setup_dir/opencode-web.bash.sha256" \
    "$base/opencode-web.bash.sha256"
  (cd -- "$setup_dir" && sha256sum --check \
    workspace-user-setup.bash.sha256 opencode-web.bash.sha256)
  dim workspace run full-dev tool-setup <"$setup_dir/workspace-user-setup.bash"
  dim workspace run full-dev bash -- -c \
    'export OPENCODE_WEB_CORS_ORIGINS="$1"; exec bash -s' \
    bash "${OPENCODE_WEB_CORS_ORIGINS:-[]}" <"$setup_dir/opencode-web.bash"
)
```

This is user-level, one-time setup for each new persistent agent home, and it
is idempotent if repeated. It is not workspace lifecycle automation: do not
add it to the image or `.dim/setup.sh`.

Launch the Project-configured agent only after setup succeeds:

```bash
dim workspace run full-dev agent
```

The generic task names do not identify a tool to DIM. This Project maps them
to its reviewed setup input and an OpenCode executable pinned in a
contract-versioned manifest below the canonical agent home. The `agent` task
rejects missing, unknown, or incompatible launcher state.

The [Codex user-tool use case](../../use-cases/codex/README.md) selects pinned
Codex with one Project-owned `.dim/project-tool.conf` file and the same setup,
manifest launcher, persistent home, and generic SSH proxy. It does not copy or
change this Project's nested-container topology.

The launcher is an explicit action, not part of setup. It prints the external
URL, username, and restricted credential-file path without printing the
password, stores restricted state below the persistent user home, and reuses
its owned healthy process and matching URL on retry. Read the reported file
explicitly for browser login; its first line is the username and its second is
the password. The Project gives the agent the common
`dim-development-service` helper and only an HTTPS development-URL socket. The
helper lets the launcher choose its loopback port and routes the resulting URL
through the lifecycle's fixed gateway along the reviewed
`agent-dind`/`dim-agent` path. The gateway is reachable without a host port
publication; neither the tool nor its local port appears in `.dim`. Configure `https-ts`
before launching with the executable HTTPS configuration:

```bash
dim install-plugin \
  '@slop-lab/dim-plugin-dns-cloudflare@0.9.0' \
  '@slop-lab/dim-plugin-external-urls@0.9.0'
CF_API_TOKEN=... \
DIM_EXTERNAL_URL_DOMAIN=dev.example.com \
DIM_EXTERNAL_URL_DNS_ZONE=example.com \
DIM_EXTERNAL_URL_DNS_VALUE=203.0.113.10 \
  bash examples/projects/configure-web-ingress.bash
```

The script creates and verifies the Caddy-backed `https-ts` ingress. An
alternative ingress requires a reviewed change to the scoped proxy's allowlist
as well as the launcher selection. The launcher consumes only
`DIM_DEVELOPMENT_URL_SOCKET`, not the generic `DIM_EXTERNAL_URL_*` capability.
`OPENCODE_WEB_CORS_ORIGINS` is a JSON array of additional exact HTTP or HTTPS
origins for browser UIs that connect to the returned URL, and defaults to `[]`.
Name the source UI origin, not that destination URL. The launcher always
includes `https://localhost:4096`, normalizes, deduplicates, and sorts the list, and
rejects invalid values or `*` before creating state. The pinned OpenCode
release does not support wildcard CORS, though OpenCode may merge its own
configured or built-in origins. Its CORS headers pass through the external
route. The browser must still send the reported Basic Auth credential in the
`Authorization` header. Repeating the same configuration reuses the owned
process; changing the port or CORS list restarts only that process and retains
the credential, URL, and shared gateway. Allow only trusted client UI origins.
Another development service can use the same helper and choose any local port
without changing `.dim`.

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

After reviewing the root and `secrets` repositories, a trusted host may start
the optional `secure` profile and deploy the secret-bearing service inside its
separate daemon:

```bash
EXAMPLE_SECRET=replace-me \
  bash examples/projects/full-development-flow/deploy-secret.bash full-dev
```

The reviewed deployment streams source into `secure-dind`; it does not mount
workspace source, agent home, Git credentials, or either Docker socket there.
Its operational script and Compose definition are resolved from the immutable
selected root rather than the mutable Project data checkout.
The agent reaches only the service's fixed health endpoint through a reviewed
port-7099 relay and cannot inspect the secure daemon or read the raw secret.

See `verification/scripts/stateful-development-flow-smoke.bash` for the disposable
end-to-end release journey. It materializes this example and injects failures
only into its temporary copy.
