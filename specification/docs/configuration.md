# Configuration

The base CLI selects a host context, with `local` as the default:

```bash
dim host add devbox --ssh developer@devbox
dim host use devbox
dim --host local ls
dim --host devbox create https://example.com/team/app.git dev
```

Client contexts live in `${XDG_CONFIG_HOME:-$HOME/.config}/dim/hosts.json`.
They contain SSH targets, not remote filesystem state or runtime credentials.
The selected Linux host must have the matching DIM CLI, Docker and Sysbox.
Sources specified as local paths refer to that host. Noninteractive SSH launch
can find either `dim` or the mise-installed launcher.

Base workspace state lives in `$HOME/.local/state/dim`; `DIM_STATE_ROOT` selects
an explicit alternative host-local directory. The base API uses complete
schema-10 records with source, resources, runtime identity and initialization
state. It does not accept a managed protected-root record as an ordinary Git
workspace or migrate existing data implicitly.

`DIM_WORKSPACE_IMAGE` selects the base image; the default is
`dev-infra-project-workspace:<installed-version>`. `dim image build` runs on the
selected host. `--image` selects another explicit build/create image. Resource
flags are `--cpus`, `--memory` and `--pids`, each accepting a positive bound or
`unlimited`. Removing an existing bound can recreate the container while
preserving its persistent data; the command reports that outcome.

Optional managed administration is installed with:

```bash
dim installer install core --with-managed
```

It uses separate default state `$HOME/.local/state/dim/managed` and runtime
socket directories below `$XDG_RUNTIME_DIR/dim/managed`. Its image namespace is
`dev-infra-managed-workspace:<installed-version>`. Explicit
`DIM_MANAGED_STATE_ROOT` and `DIM_MANAGED_WORKSPACE_IMAGE` select alternatives.
A common `DIM_STATE_ROOT`/`DIM_WORKSPACE_IMAGE` remains an explicit override when
running managed administration, rather than changing the base defaults.

Native Git integrations use `DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` and a
separate `DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE`. Those private files and
managed Project/CI configuration are required only for that integration. The
advanced control-plane installer takes a caller-owned configuration through
`dim installer install control-plane --config FILE`. It does not become the
base development host by being installed.

The detailed [configuration reference](../specs/03-configuration.md) currently
covers managed features. The rework plan tracks its consolidation with these
base host/context settings. Older schemas and internal formats have no stable
compatibility guarantee; preserve user data explicitly before replacing state.
