# Multi-Repository Project

This is the expanded DIM Project shape for cases that need independent
repository or secret-bearing review boundaries. Start with the
[`single-repository`](../single-repository/README.md) example unless those
boundaries are useful.

```text
repos/
├── root/       reviewed Project lifecycle and agent definition
├── web/        ordinary application source
└── secrets/    reviewed source for a secret-bearing service
```

The committed [`repos.yml`](repos/root/.dim/repos.yml) defines the complete
reviewed repository set. The root repository owns Project lifecycle and task
dispatch, while all three repositories remain part of the same reviewable
Project.

Feature-specific examples live under [`../../features`](../../features).

## Try it

Install DIM, then from this directory:

```bash
bash create-repositories.bash
bash register-project.bash
dim workspace create example example-dev
```

The registration script runs:

```bash
dim project create example \
  --bootstrap-git-url example-repositories/root \
  --bootstrap-git-ref main \
  --no-apply-repos
dim repo apply example --yes
```

The example deliberately skips the discovered set and then applies it from
the managed root to verify that declining `Apply it?` never requires another
local clone. Normal unattended setup can use `--apply-repos` directly.

Only the root repository is cloned automatically into the trusted workspace.
Reviewed lifecycle code can reach the other managed repositories through
their Project URLs:

```bash
dim repo url example web
dim repo url --workspace example secrets
```

Run a shell:

```bash
dim workspace run example-dev bash
```

Arguments can follow `--`:

```bash
dim workspace run example-dev bash -- -lc 'git status'
```

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
  dim workspace run example-dev tool-setup <"$setup_dir/workspace-user-setup.bash"
  dim workspace run example-dev bash -- -c \
    'export OPENCODE_WEB_CORS_ORIGINS="$1"; exec bash -s' \
    bash "${OPENCODE_WEB_CORS_ORIGINS:-[]}" <"$setup_dir/opencode-web.bash"
)
```

This is user-level, one-time setup for each new persistent agent home, and it
is idempotent if repeated. It is not workspace lifecycle automation: do not
add it to the image or `.dim/setup.sh`.

Launch the Project-configured agent only after setup succeeds:

```bash
dim workspace run example-dev agent
```

The generic task names do not identify a tool to DIM. This Project maps them
to its reviewed setup input and an OpenCode executable pinned in a
contract-versioned manifest below the canonical agent home. The `agent` task
rejects missing, unknown, or incompatible launcher state.

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
publication. Reviewed `.dim` setup binds `opencode-web` to the exact
workspace-scoped label ending in `-<16-hex-workspace-hash>--opencode`; other logical service
names are denied on this socket. The application port remains gateway-local.
Configure `https-ts`
before launching with the executable HTTPS configuration:

```bash
dim install-plugin \
  '@slop-lab/dim-plugin-dns-cloudflare@0.9.0' \
  '@slop-lab/dim-plugin-external-urls@0.9.0'
CF_API_TOKEN=... \
DIM_EXTERNAL_URL_DOMAIN=dev.example.com \
DIM_EXTERNAL_URL_DNS_ZONE=example.com \
DIM_EXTERNAL_URL_DNS_VALUE=203.0.113.10 \
  bash ../configure-web-ingress.bash
```

The script creates and verifies the Caddy-backed `https-ts` ingress. An
alternative ingress requires a reviewed change to the scoped proxy's allowlist
as well as the launcher selection. The launcher consumes only
`OPENCODE_WEB_URL_SOCKET`, not the generic `DIM_DEVELOPMENT_URL_SOCKET` or
`DIM_EXTERNAL_URL_*` capabilities. The configured ingress requires host
approval before each requested route becomes reachable.
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
Other development services can use the generic development URL socket and
choose any local port without changing `.dim`.

Both private Docker daemons listen only on their dedicated Unix sockets. Their
reviewed entrypoints pass the Unix host explicitly because an empty invocation
of the upstream DinD entrypoint would also enable Docker TCP port 2375 when TLS
is disabled. On first use, `agent-dind` gives the empty named home root to its
mapped inner agent identity with mode `0700`; a populated root with
incompatible ownership or mode fails closed. Inner setup changes only that
top-level directory to the existing nonroot agent identity and does not
recursively rewrite persisted descendants. Agent tasks remain nonroot and keep
their documented container-local `sudo` contract.

Export or restore only the Project-owned agent home as a gzip tar stream:

```bash
dim workspace run example-dev backup >example-dev-home.tar.gz
dim workspace run example-dev restore <example-dev-home.tar.gz
```

The Project defines this format and task mapping; DIM only streams stdin,
stdout, stderr, and the task exit status. The task stops the agent for
consistency and uses a networkless temporary container with only the named
home volume mounted read-only for backup or read-write for restore.

## Trust and container boundaries

The trusted root checkout owns `.dim/setup.sh`, Compose configuration, and the
fixed `.dim/entrypoint.sh` task mapping. Setup obtains the host Git author
through DIM's narrow host-input API, starts `agent-dind`, and asks its reviewed
launcher to create the actual `dim-agent` container.

```text
host-side DIM runtime
└── trusted workspace container
    ├── agent-dind (private rootless Docker daemon)
    │   └── dim-agent (unprivileged agent container)
    └── secure-dind (optional private rootless Docker daemon)
        └── dim-secret-service (reviewed secret-bearing container)
```

The agent receives the host author, managed Project Git credentials, mutable
Project source, and only the Unix socket of `agent-dind`. It receives neither
the host Docker socket nor the trusted workspace or `secure-dind` socket. The
outer Compose graph contains only the two daemon services; their inner
containers remain inside the workspace's existing resource and isolation
boundary.
Agent tasks run as the workspace owner's nonroot identity and may use
passwordless `sudo` only for root inside the agent container. That container
root has neither the trusted workspace's runtime socket nor host authority.

The agent and `agent-dind` share only the named volume mounted at
`/mnt/workspace-shared-dind`. Bind-mounted nested workloads must use a source
below that path so the source has the same meaning from both containers.
Because the unprivileged agent and rootless DinD may have different host UIDs,
the shared volume root is a sticky writable directory. A bind-source directory
that both sides must modify must grant write access to both identities, for
example `mkdir -m 0777 /mnt/workspace-shared-dind/my-bind`.

DIM core does not know that this service is an agent. The root repository owns
its image, service lifecycle, resource choices, and fixed task mapping through
the ordinary setup, Compose, entrypoint, and teardown contracts.

## Secret-bearing service

A trusted operator can deploy the reviewed source from the managed `secrets`
repository while supplying the secret out of band. Deployment starts the
optional `secure` profile, streams the reviewed build context into
`secure-dind`, and passes the secret only to its launcher:

```bash
EXAMPLE_SECRET=not-a-real-secret bash deploy-secret.bash
```

The wrapper executes the operation and Compose definition from the immutable
selected root, not from the agent-writable Project data checkout. Re-running
setup treats the selected profiles as authoritative: clearing `secure` stops
the outer secure daemon, and clearing `documentation` removes any old
restart-enabled preview from the persistent agent daemon.

Check it from the trusted workspace:

```bash
dim workspace exec example-dev -- sh -c \
  'exec sh "$DIM_PROJECT_ROOT/ops/secret-service.sh" secret-health'
```

Or through its constrained HTTP interface from the agent:

```bash
dim workspace run example-dev bash -- \
  -lc 'curl --fail --silent --show-error --max-time 5 http://secret:7099/healthz'
```

The health response reports only whether a secret was configured. A fixed
Project-reviewed TCP relay carries only this service traffic from the agent
side to port 7099 in `secure-dind`; it carries no Docker control protocol. The
agent's private Docker daemon cannot list the secure daemon's container, and
neither the raw secret nor the secure daemon socket enters the agent
environment. Never commit a real secret.

Remove the service and workspace:

```bash
dim workspace exec example-dev -- sh -c \
  'exec sh "$DIM_PROJECT_ROOT/ops/secret-service.sh" remove-secret'
dim workspace discard example-dev --yes
```

## Development verification

DIM contributors can materialize all three repositories and verify this exact
example:

```bash
just verify example current-installed auto multi-repository
just verify example runc use multi-repository
```
