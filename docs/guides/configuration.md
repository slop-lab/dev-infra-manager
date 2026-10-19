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

Managed Project/service state defaults to `$HOME/.local/state/dim/managed`;
`DIM_MANAGED_STATE_ROOT` selects an alternative. Controller sockets live below
`$XDG_RUNTIME_DIR/dim/managed`. Managed sources use the base workspace runtime,
image and volumes; there is no separate managed workspace image or backend file.

`dim control-plane prepare DIRECTORY` generates private role and service
configuration from reviewed image digests. After installing the configured
services through the facade, `dim control-plane connect DIRECTORY`
validates the serving generation and records host-local connections. Explicit
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` and
`DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE` override saved selection. Configure
connections on the selected development host for SSH workspace creation.

The advanced installer accepts caller-owned configuration through
`dim installer install control-plane --config FILE`. Neither installation nor
connection is required for an ordinary Git source.

See the [configuration reference](../specs/03-configuration.md) for ownership
and role boundaries. Internal formats have no stable compatibility guarantee;
preserve user data explicitly before replacing incompatible state.
