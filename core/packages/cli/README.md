# @slop-lab/dim-cli

`dim` creates persistent, isolated development workspaces from ordinary Git
repositories on a local or SSH host. Managed Git, review and CI are optional.
Repositories do not need `.dim` configuration.

## Installation

The supported facade is `@slop-lab/dim-installer`. Install the same exact
version on each development host:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.10.0'
dim installer install core
dim doctor
```

Linux development hosts need Docker, Compose, Buildx and `sysbox-runc`. A remote
client needs Node.js and SSH; runtime operations execute on the selected host.

## Local development

```bash
dim image build
dim create https://example.com/team/app.git dev
dim ls
dim show dev
dim shell dev
dim exec dev -- git status
dim run dev exec -- docker compose up -d
dim resources dev --cpus 4 --memory 8g --pids 4096
dim stop dev
dim start dev
dim recreate dev
dim discard dev --yes
```

`create SOURCE NAME` accepts a Git URL or path on the selected host and an
optional `--ref`. Checkout, user home and private Docker data survive stop,
start and recreation. `discard` deletes all three and requires confirmation.
Resource values can be positive limits or `unlimited`; changing resources may
recreate the container while retaining those persistent volumes.

`dim run dev` opens a shell. `run dev exec -- COMMAND`, `run dev custom --
COMMAND` and `exec dev -- COMMAND` execute ordinary commands without custom
Project hooks. The `workspace` group exposes the same operations when explicit
grouping is helpful.

## SSH development hosts

```bash
dim host add devbox --ssh alice@devbox
dim host use devbox
dim image build
dim create https://example.com/team/app.git dev
dim shell dev
dim --host local ls
dim host list
dim host remove devbox
```

SSH targets use existing SSH configuration, including keys, ports and jump
hosts. Requests and terminal streams travel over SSH; no host-admin HTTP port
is exposed. Non-interactive shells can find the installer through mise without
an activated shell PATH.

Contexts live in `~/.config/dim/hosts.json` (or `$XDG_CONFIG_HOME/dim/hosts.json`).
Workspace state and source paths belong to the execution host. Inspection does
not start a controller or provision runtime resources. Removing a context
changes client configuration only.

## Access workspace services

Run a server bound to loopback inside the workspace, then forward it in another
terminal:

```bash
dim exec dev -- python3 -m http.server 3000 --bind 127.0.0.1
# In another terminal:
dim forward dev 3000:3000
```

Open `http://127.0.0.1:3000` on the client. Forwarding uses the selected local or
SSH host and binds only the client's loopback interface. Local port `0` selects
an available port and reports it on stderr. Stop forwarding with Ctrl-C.
The connection remains pinned to the original workspace identity; discarding
and recreating another workspace with the same name requires restarting the
forward.

`dim connect dev 3000` exposes the same workspace loopback connection as raw
stdin/stdout for protocol clients such as SSH ProxyCommand. It never allocates
a terminal or writes status messages into the protocol stream. These commands
do not require managed Git, external URL plugins or host-published Docker ports.

## Optional managed administration

```bash
dim installer install core --with-managed
dim managed --help
```

The additional exact-version `@slop-lab/dim-managed` package owns managed
workspaces, native Git, review, CI, controller services and their plugins.
Installing the base CLI does not install or import it. Selecting an unavailable
managed command reports how to add the component.

`dim installer install control-plane` configures native services separately;
ordinary development does not require either the managed component or those
services. See the managed package's administration documentation for reviewed
Project bootstrap and service configuration.
