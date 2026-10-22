# Development workspaces

A runtime host needs Linux, Git, Docker and registered `sysbox-runc`. The client
can use that host locally or through an existing SSH connection. The default
flow requires no Project, control plane, CI service or `.dim` configuration.

## Install development sources

Published `0.10.0` packages use the earlier managed architecture. To try the
current base flow, prepare and install this branch's matched source bundle:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.10.0'
mise install
pnpm install --frozen-lockfile
just prepare-local
just install-local
```

The first command installs the preserved facade. Preparation builds packages,
the workspace image and Native Git/execution images from one source identity and
lockfile. Installation uses those artifacts without rebuilding them and installs
the complete local development profile, including all bundled host and
control-plane plugins. It deploys the local service pair, renews generation-bound
connections, and restarts the controller and Web UI. Published installation
retains its explicit optional component selection.
The matching installer is retained under the DIM data directory. With mise,
installation links and selects that exact source facade globally, so later
installer commands use the same implementation. Without mise, add the printed
facade directory to PATH.
Preparation rejects dirty source by default; use a reviewed clean commit.

To update while preserving workspaces, run `just prepare-local` followed by
`just install-local` again. Existing containers, checkout/home/nested-Docker data
and guest processes remain in place. Existing containers keep their current image;
apply a new guest image through a separate explicit recreation. Controller,
service and Web connections can briefly interrupt during restart.

Control-plane updates checkpoint both stopped service volumes under `.local/backups`
and restore both together if activation fails. Repositories, proposals, credentials,
ports and configured worker profiles are retained. Incomplete transactions stop
installation for explicit recovery. On first use with an existing deployment,
verified private snapshots are adopted into `~/.config/dim/local-control-plane`;
subsequent installs reuse that setup. Edit its service configuration for later
updates. `DIM_LOCAL_CONTROL_PLANE_SETUP` selects an existing absolute setup directory
instead; default paths follow `XDG_CONFIG_HOME`.

Prepared services use an owned, loopback-only writable development image registry,
separate from pull-through caches. `DIM_LOCAL_IMAGE_REGISTRY=HOST:PORT` selects an
operator-managed writable registry instead. Cache retention preserves the owned
registry's data and ownership record across a clean reinstall. A fresh scheduler
has no execution slots: reviewed worker runtime profiles remain explicit.

`install-local` also installs the matched Web UI and the LLM router, execution,
Native Git, Workspace tools and External routes Web plugins in a separate runtime under
`DIM_DATA_HOME/web/runtime`. It configures the built-in
`local` host and creates a browser account on first installation. With user
systemd available, `dim-web.service` starts at `http://127.0.0.1:9081`; otherwise
installation prints the command to serve it manually. Read the initial username
and password from `~/.config/dim/web/login.txt` (mode `0600`). Configuration lives
in `~/.config/dim/web/config.json`; these paths follow `XDG_CONFIG_HOME`.
Repeated installs preserve the account and existing plugin settings, add missing
plugins from the development profile, and restart the service with the selected
runtime. An existing private `~/.config/dim/llm/operator.json` supplies the initial
LLM router connection. Native Git and execution discover the selected local
control plane automatically. Other services require their account, network or
runtime configuration before use. Installation does not invent a project; existing
plugin settings are preserved.
See [Web plugins](web-plugins.md) for connection settings. Local uninstall removes the Web UI service and its
configuration; a clean reinstall creates a new account.

For a browser on another machine, forward the loopback port with
`ssh -L 9081:127.0.0.1:9081 USER@HOST`, then open `http://127.0.0.1:9081`.
Use `systemctl --user status dim-web.service` and
`journalctl --user -u dim-web.service` for service diagnostics. Add other trusted
hosts or optional review/execution connections using the
[Web UI configuration guide](../../packages/web/core/README.md).

A source host bootstrap is available for a disposable Ubuntu VM in
[bootstrap-ubuntu-vm.md](../development/bootstrap-ubuntu-vm.md). Do not use
host provisioning commands inside an ordinary development workspace.

## Create and use

```bash
dim doctor
dim image build
dim create https://example.com/team/app.git dev --ref main
dim ls
dim show dev --json
dim shell dev
dim exec dev -- git status
dim exec dev -- docker compose up -d
```

Replace the example URL with a real repository. A local repository path refers
to the selected host; only committed content is acquired. The initial checkout
is private, without a writable host bind or host credential files. A portable
origin is retained; access to a private remote from inside the workspace needs
explicit user configuration. DIM does not forward an SSH agent automatically.

Tool installation and repository setup are ordinary commands inside the
workspace. Put reusable setup in repository scripts. Checkout, home and private
Docker data persist across sessions and container recreation.

```bash
dim stop dev
dim start dev
dim restart dev
dim recreate dev
dim resources dev --cpus 4 --memory 8g --pids 4096
dim resources dev --cpus unlimited --memory unlimited --pids unlimited
```

Removing limits can recreate the container while preserving its data. Recreation
does not fetch a new source revision or reset the working tree. Use Git inside
the workspace for source updates. List/show distinguish persisted lifecycle
phase from the observed runtime status. Missing initialized data is an error;
DIM does not silently replace it with an empty volume.

`dim discard dev --yes` removes the workspace and its owned volumes. Export
needed data before discarding. Failed cleanup retains a record for retry and
does not remove resources whose ownership cannot be verified.

Common workspace commands also work under `dim workspace`; `list` accepts
`ls`. Record commands offer `--json`, while `exec` preserves stdin, stdout,
stderr and the command's exit status.

## Select a remote host

Install the same DIM source build and runtime prerequisites on the remote host
first. Configure ordinary SSH authentication and host-key verification, then:

```bash
dim host add devbox --ssh developer@devbox
dim host use devbox
dim doctor
dim create /srv/repositories/app dev
dim shell dev
dim --host local ls
dim host list
```

Workspaces, source paths, images and runtime operations belong to the selected
host. The client invokes DIM through SSH; there is no required public host
administration endpoint. `dim host use local` restores the default context.

## Remove or reinstall a local source installation

The repository provides local maintenance tools; these are not published DIM
commands. Run them from this source checkout with the supported Node.js runtime.
Inspect the removal plan first:

```bash
just uninstall-local --dry-run
# Equivalent: bash scripts/uninstall-source-build.bash --dry-run
```

In a terminal, uninstall and reinstall ask whether to keep local package cache
data (`Y/n`), then ask for confirmation before destroying the installation
(`y/N`). Pressing Enter keeps cache data and declines removal. `-y` (or `--yes`)
skips confirmation and selects the default cache retention; use
`--no-keep-cache-data` to explicitly delete cache payloads. Noninteractive
execution needs `-y`. Without it, uninstall previews only and reinstall refuses
to proceed. Use `--dry-run` for an explicit noninteractive preview.

Removal destroys the selected current user's local DIM workspaces and runtime
installation. LLM router accounts, authentication, history and captures, and
Tailscale gateway configuration and authentication state are always retained.
Configured shared ingress connections, private service configuration and the selected
Caddy deployment and TLS volumes also survive, even with `--no-keep-cache-data`.
The scope follows the current environment's DIM paths on this machine; the selected SSH host is not
contacted. Keep any data you need before executing it. Role-specific private
control-plane configuration stored outside DIM's own directories is not
automatically deleted.

To remove that local installation and install the prepared source candidate:

```bash
just prepare-local
just reinstall-local --with-managed --dry-run
just reinstall-local --with-managed
# The complete local development profile is installed by default.
# For automation, add -y after reviewing the plan.
```

The cache retention choice covers cache-server data volumes (including Docker, npm,
PyPI and apt) and their ownership ledgers. Cache containers, networks, endpoint
catalogs and runtime configuration are replaced. Reinstall records the
previously installed cache-server and mirrors plugins and selected cache kinds,
installs their matching prepared packages, ensures those cache services, then
restores mirror connections with fresh endpoints. Other workspace, plugin
and control-plane configuration is not restored automatically. The separately
retained LLM router and Tailscale service data is preserved regardless of this
cache choice. Runtime processes, gateway containers and networks are removed;
retention does not leave those services running.

`--keep-cache-data` explicitly selects retention; `--no-keep-cache-data`
deletes cache payloads while retaining LLM router and Tailscale data. For example:

```bash
just reinstall-local --with-managed -y                        # Keep cache data.
just reinstall-local --with-managed -y --no-keep-cache-data   # Delete cache data.
```

Retries after interrupted removal must use the same cache retention choice.
See [Tailscale gateway setup](tailscale.md) to reconnect the retained gateway
identity after installing its matching plugin.

A repository source installation restores optional shared ingress from private
`~/.config/dim/shared-ingress/services.json`, containing only the external-urls
control-plane plugin. It rebuilds that isolated runtime and starts
`dim-shared-ingress.service`, then restores the host external-urls plugin.
A mode-`0600` `shared-ingress/edge.json` containing
`{"schemaVersion":1,"ingressName":"shared"}` selects the existing source-owned
Caddy compose deployment under
`~/.local/state/dim/plugins/external-urls/caddy/shared/`. Its private configuration,
`.env` and matching TLS volumes are retained and the deployment is restarted.
Only the selected edge's verified resources are retained. These helpers belong
to repository development installation, not the published installer.

`reinstall-local` confirms the removal plan, then invokes removal and the
existing source installer. It does not prepare a new candidate: rerun `just prepare-local` after
source changes. The source checkout and its `.local` prepared artifact bundle
remain available. Shared Docker, Sysbox, Incus and Tailscale installations, root
AppArmor setup, and upstream or prepared build images are retained.

## Optional managed integration

A prepared source bundle installs the complete local development profile:

```bash
just install-local
```

The older `--with-managed` spelling is accepted but no longer changes this local
profile. Published optional integration still uses
`dim installer install core --with-managed`: it installs host integration and
administration packages without deploying a control plane or starting workers.

Prepare and connect the explicit Git/review/CI service profile through the control-plane operator CLI:

```bash
dim control-plane prepare /absolute/operator/deployment \
  --native-git-image registry.example/native-git@sha256:DIGEST \
  --execution-image registry.example/ci@sha256:DIGEST
dim installer install control-plane --config /absolute/operator/deployment/install.json
dim control-plane connect /absolute/operator/deployment
```

Supply actual reviewed image digests. The prepare command reports the exact
configuration path and follow-up commands. Connecting checks the live service
generation and stores private host connections. Bootstrap/register Projects
with those scoped roles, then create their workspaces through `dim create
dim://PROJECT NAME`. Ordinary Git workspaces use the same lifecycle without
these services.

The [installer specification](../specs/14-installer-facade.md) defines facade
installation and recovery. See [managed administration](../../packages/host/plugins/native-git/docs/cli.md)
for optional Project/review/CI operations and explicit service roles.

Managed administration also follows the selected host:

```bash
dim --host devbox control-plane connect /srv/dim/deployment
dim --host devbox managed project list --json
dim --host devbox create dim://PROJECT dev
```

The remote host holds Project state and private role files. The client can have
only the base CLI; optional code is loaded on the host that executes the
operation. `dim host use devbox` selects that host for subsequent commands.
The root `dim controller ...` entry point stays local for installer activation;
use `dim --host devbox managed controller ...` for remote administration.
