# Bootstrap a fresh Ubuntu VM

This bootstrap installs one DIM candidate from one reviewed source commit on a
fresh Ubuntu 24.04 amd64 VM. Run it as the normal sudo-capable operator from a
clean checkout at the reviewed commit. Do not run it as root.

The initial supported roles are:

- `ordinary`: Docker CE with the containerd image store, Buildx, Compose v2,
  Sysbox, the pinned source toolchain, and the source-built DIM candidate.
- `control-qemu`: everything in `ordinary`, plus QEMU tooling and mandatory
  access to a real `/dev/kvm`. The bootstrap provisions and checks device
  access; it does not run a functional KVM acceleration probe. There is no TCG
  fallback.

## Review the plan

Help and plan output are read-only. They may inspect a dirty preview checkout,
but `--print-plan` explicitly does not validate a candidate.

```bash
bash scripts/bootstrap-ubuntu-vm.bash --help
bash scripts/bootstrap-ubuntu-vm.bash --role ordinary --print-plan
bash scripts/bootstrap-ubuntu-vm.bash --role control-qemu --print-plan
```

## Run a role bootstrap

Set `REVIEWED_SHA` to the full lowercase 40-hex commit reviewed for the
candidate. The checkout must have that exact `HEAD`, no tracked modifications,
and no untracked files. The package version must be `0.10.0` unless the command
explicitly selects another expected pre-stable version.
Use the default user paths: unset DIM config/data/plugin/install/state path
overrides and `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME`.
Also unset `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`,
`DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, and `DOCKER_API_VERSION`. The
bootstrap accepts only Docker's `default` context when it resolves to the local
system Unix socket.

Ordinary host:

```bash
REVIEWED_SHA=REPLACE_WITH_FULL_REVIEWED_COMMIT
bash scripts/bootstrap-ubuntu-vm.bash \
  --role ordinary \
  --source-sha "$REVIEWED_SHA" \
  --expected-version 0.10.0 \
  --acknowledge-fresh-vm
```

Control and QEMU host:

```bash
REVIEWED_SHA=REPLACE_WITH_FULL_REVIEWED_COMMIT
bash scripts/bootstrap-ubuntu-vm.bash \
  --role control-qemu \
  --source-sha "$REVIEWED_SHA" \
  --expected-version 0.10.0 \
  --acknowledge-fresh-vm
```

`--acknowledge-fresh-vm` is an explicit assertion that this disposable VM has
no DIM state or Docker workloads to adopt, migrate, or preserve. Before any
privileged or network operation, the bootstrap refuses existing DIM product or
prepared state, Docker containers, volumes, images, non-default networks,
daemon configuration, systemd Docker overrides, existing Docker or containerd
data roots, and a foreign DIM facade. It never deletes Docker data, removes
conflicting packages, or overrides daemon configuration.

## Refresh groups and resume

The first run may add the operator to `docker` and, for `control-qemu`, `kvm`.
When the command exits with status `3`, log out of the VM completely and log
back in. Rerun the identical command. Do not use `sg`, a forged
`XDG_RUNTIME_DIR`, or a sudo shell to bypass the login boundary.

Before host mutation, the bootstrap writes an owner-only resume marker at
`~/.local/state/dim-bootstrap/ubuntu-vm.state`. A resume accepts only an
`awaiting-login` marker matching the exact role, reviewed source SHA, expected
version, operator UID, generated backend-config digest, and absent-or-exact
bootstrap-produced Docker daemon-config digest. It then skips all host
installers. A changed, foreign, incomplete, or completed marker fails closed
rather than adopting state.

The resumed run verifies the local Docker context and socket, every exact
Docker/Sysbox package pin, the daemon version, containerd image store, Sysbox
runtime, source tool versions, and role-specific KVM access. It then invokes
the existing source flow exactly as follows:

```bash
DIM_SOURCE_ROOT_COMMIT="$REVIEWED_SHA" just prepare-local
DIM_SOURCE_ROOT_COMMIT="$REVIEWED_SHA" just install-local
```

## Installed paths and pins

- Node.js 24.19.0: `/usr/local/lib/dim-qemu-node-24.19.0`
- pnpm 10.13.1 and Just 1.43.1:
  `/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1`
- Prepared candidate bundle: `<checkout>/.local/dim-packages`
- Durable candidate runtime:
  `~/.local/lib/dim-candidates/<local-bundle-version>-<reviewed-sha>`
- Operator facade: `~/.local/bin/dim`

The facade executes the packaged POSIX launcher with the dedicated trusted Node
and pinned source-tool directories first in `PATH`, so it remains usable after
a new login without publishing or replacing `/usr/local/bin/node`. Invoke the
pinned build tools explicitly when needed:

```bash
/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin/just --version
/usr/local/lib/dim-source-tools-24.19.0-10.13.1-1.43.1/bin/pnpm --version
```

Candidate publication holds `.local/prepare-install.lock` while it revalidates
the prepared-state digest, source SHA, local bundle version, exact installer
manifest entry, and installer tarball identity before and after staging. It
publishes the facade only after the staged launcher reports the same full local
bundle version; concurrent or altered preparation fails closed.

The executable downloads are fixed URLs with embedded SHA-256 values. Docker
uses Docker's signed Noble APT repository, verifies signing-key fingerprint
`9DC858229FC7DD38854AE2D88D81803C0EBFCD88`, installs exact package versions,
and places the five Docker packages on hold. Sysbox 0.7.0 uses its existing
architecture-specific embedded SHA-256.

Reviewed executable artifacts:

| Tool | Official artifact | SHA-256 |
| --- | --- | --- |
| Node.js 24.19.0 | `https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz` | `14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647` |
| pnpm 10.13.1 | `https://github.com/pnpm/pnpm/releases/download/v10.13.1/pnpm-linux-x64` | `e1cab530ea8252eb90e4add71d95838fd6f2656e6977f120df5ecb6f5b2822e0` |
| Just 1.43.1 | `https://github.com/casey/just/releases/download/1.43.1/just-1.43.1-x86_64-unknown-linux-musl.tar.gz` | `6a3003f68fa4d86ada8afe33830a88ffdb6c2fcaff4e5a840b1cb90eaf6f46fc` |
| Sysbox 0.7.0 | `https://downloads.nestybox.com/sysbox/releases/v0.7.0/sysbox-ce_0.7.0-0.linux_amd64.deb` | `eeff273671467b8fa351ab3d40709759462dc03d9f7b50a1b207b37982ce40a9` |

The Noble Docker package tuple is `docker-ce` and `docker-ce-cli`
`5:29.1.4-1~ubuntu.24.04~noble`, `containerd.io`
`2.2.1-1~ubuntu.24.04~noble`, `docker-buildx-plugin`
`0.31.1-1~ubuntu.24.04~noble`, and `docker-compose-plugin`
`2.40.3-1~ubuntu.24.04~noble`. The bootstrap also requires `docker compose
version --short` to report exactly `2.40.3`.

## Operator handoff

The bootstrap does not create TLS material, secrets, native connection JSON,
worker configuration, systemd worker units, user lingering, or native CI
services. It does not publish packages, create tags, or start a release. After
the candidate facade reports the expected version, continue with
[host readiness](host-install-readiness.md) for ordinary remote development
and optional operator-owned service setup.

Run both roles against the exact candidate using the acceptance profile below.
Retain guest phase logs and the outer invocation's final status separately;
passing guest stages do not establish that the complete outer invocation passed.

## Disposable fresh-VM acceptance profile

`verification/scripts/bootstrap-ubuntu-vm-smoke.bash` drives both role commands
through two sequential fresh guests. It uses the official dated Ubuntu 24.04
amd64 cloud image at
`https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img`,
whose SHA-256 in Ubuntu's dated `SHA256SUMS` is
`6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2`.
The URL and checksum are embedded in the driver; it does not consult `latest`
or update the checksum from network metadata.

The ordinary guest has 2 vCPUs, 2 GiB RAM, and a thin 32 GiB overlay. The
control/QEMU guest runs afterward with 2 vCPUs, 3 GiB RAM, and a fresh thin
32 GiB overlay. Both use KVM only, loopback-only randomized SSH forwarding,
preseeded ephemeral SSH host keys, and a UID-1001 `dim` operator with
guest-local passwordless sudo. The first SSH login must finish the bootstrap
with status 3; a new SSH login performs the resume. Each guest proves the
installed `0.10.0-local-<64 lowercase hex>` facade and a real Sysbox container.
The control/QEMU guest additionally checks the current service images,
installs matched tarballs into isolated prefixes with `just verify installer-artifacts`, and runs
`just verify native-basic-lifecycle` gates. It does not create persistent
operator TLS material, native global-role credentials, worker deployments, or
a generic multi-host bridge; the gates own and clean their disposable fixtures.
The acceptance profile installs the checkout's frozen development dependencies
before these source gates. Production bootstrap itself builds in an isolated
source archive; it does not populate the checkout's `node_modules`.

For a standalone KVM host, invoke the profile with an absolute bundle path and
the exact commit and tree it contains:

```bash
bash verification/scripts/bootstrap-ubuntu-vm-smoke.bash \
  --source-bundle /absolute/reviewed/root.bundle \
  --source-sha FULL_40_HEX_COMMIT \
  --source-tree FULL_40_HEX_TREE
```

The equivalent manifest form is:

```bash
bash verification/scripts/bootstrap-ubuntu-vm-smoke.bash \
  --source-bundle /absolute/reviewed/root.bundle \
  --source-manifest /absolute/reviewed/manifest.json
```

`manifest.json` has exactly this schema; additional or missing properties are
rejected:

```json
{
  "schemaVersion": 1,
  "sourceSha": "FULL_40_HEX_COMMIT",
  "sourceTree": "FULL_40_HEX_TREE"
}
```

The disposable outer verification guest recognizes one fixed protected input
layout only:

```text
/mnt/dim-inputs/bootstrap-source/root.bundle
/mnt/dim-inputs/bootstrap-source/manifest.json
```

When the fixed `bootstrap-source` directory exists,
`kvm-guest-verification-smoke.bash` adds the `fresh-ubuntu-bootstrap` stage and
dispatches the delegate's fixed `bootstrap`
mode, including when its files are not yet readable. Without that directory,
the default nine-stage aggregate is unchanged.
The delegate takes no source path, SHA, command, or arbitrary executable from
the caller. Place both regular files directly in one private host directory
and pass that directory through the existing protected service input API:

```bash
export DIM_QEMU_NODE_EXECUTABLE=/usr/local/lib/dim-qemu-node-24.19.0/bin/node
sudo -v
bash verification/scripts/kvm-host-install-smoke.bash \
  --input bootstrap-source=/absolute/private/bootstrap-source
```

In a workspace with this reviewed Project's broker already provisioned, use
the client instead of the trusted-host setup command:

```bash
node .dim/qemu-client.mjs run \
  --input "bootstrap-source=$BROKER_SOURCE_ROOT/.local/verification/bootstrap-source"
```

`BROKER_SOURCE_ROOT` is the operator-provided source root in the broker's mount
namespace. An agent's `/workspace` path need not exist in that namespace.
Obtain the exact broker-side source path from the operator; do not infer a
product-wide host path or an additional capability grant from the agent path.

Before delegation, the disposable-guest guard validates and seals only the two
fixed regular, single-link input files and their directory, then assigns them
to UID 1001. Root-owned transport copies are made owner-read-only before
ownership transfer. Host originals, source bytes, staged host code, and device
permissions are not changed; SHA/tree verification still follows the handoff.

The existing launcher snapshots the directory as `bootstrap-source`; no new
root command or service API is used. Inside the guest its fixed aggregate
command remains:

```bash
cd /home/dim/dim/workbench
bash verification/scripts/kvm-guest-verification-smoke.bash
```

SSH readiness is bounded to 15 minutes, each source transfer to 5 minutes,
the image download to 30 minutes, and each provisioning or live-gate command
to 90 minutes. QEMU PIDs, process start times, private overlay paths, and
temporary-directory identities are checked before cleanup. An ownership or
cleanup ambiguity preserves the private work directory and returns status 125.
Role console, bootstrap, installer, lifecycle, image, and source-identity logs
remain under the printed mode-0700 evidence directory.
