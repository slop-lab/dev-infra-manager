# Optional DIM managed services

`@slop-lab/dim-managed` owns managed Project workspaces, native Git integration,
review and CI workers, host controllers, plugins, and their deployment assets.
The base `@slop-lab/dim-core` package operates local and remote Git workspaces
without these services. The CLI loads this package only for managed commands.

Managed state defaults to `~/.local/state/dim/managed`, with controller sockets
beneath the runtime directory's `dim/managed` namespace. Set
`DIM_MANAGED_STATE_ROOT` to select another managed state root; `DIM_STATE_ROOT`
is also accepted when an explicit application context supplies it.

Managed workspace images use `dev-infra-managed-workspace:<version>`; base
workspace images use `dev-infra-project-workspace:<version>`. Build the managed
image with `dim managed workspace image build`. `DIM_MANAGED_WORKSPACE_IMAGE`
selects an explicit managed image, with `DIM_WORKSPACE_IMAGE` as a contextual
fallback. Building either default image cannot replace the other feature's image.

## Prepare optional control-plane services

Managed administration prepares the service configuration; the installer facade
owns deployment, readiness, replacement and recovery. On the trusted operator
host, select reviewed image digests and a new private directory:

```bash
dim managed control-plane prepare "$HOME/dim-control-plane" \
  --native-git-image registry.example/dim/native-git@sha256:COMPLETE_DIGEST \
  --ordinary-ci-image registry.example/dim/ordinary-ci@sha256:COMPLETE_DIGEST
# Review the generated install.json, service configurations and review-policy.json.
dim installer install control-plane --config "$HOME/dim-control-plane/install.json"
dim managed control-plane connect "$HOME/dim-control-plane"
```

Preparation generates independent role credentials and readiness tokens as
mode-0600 files in a mode-0700 directory. It refuses to replace an existing
directory. Services publish only on loopback by default. The initial operator
host has registrar, root importer, root reader, workspace writer and promoter
roles; reviewer `owner` has its own credential. No CI worker or capacity is
invented. The sample review policy requires that human reviewer and no CI jobs.
Edit the reviewed policy and configure real worker capacities before requiring
CI. Preparation installs nothing and sends no credentials over the network.

`connect` verifies live service role identities and the exact generation before
writing `connections/host.json`, `registrar.json`, `importer.json`,
`reviewer.json` and `promoter.json`. It does
not select a backend, start a host controller or install a UI. The initial host
connection supports Projects whose policies require no CI. Use the generated
connections to import an ordinary local repository:

```bash
export DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$HOME/dim-control-plane/connections/host.json"
export DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE="$HOME/dim-control-plane/connections/importer.json"
dim managed project bootstrap-native-root example \
  --project-id example \
  --source-repository /absolute/path/to/repository \
  --source-ref refs/heads/main \
  --registrar-connection "$HOME/dim-control-plane/connections/registrar.json" \
  --importer-connection "$DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE" \
  --review-policy "$HOME/dim-control-plane/review-policy.json"
dim managed project create example
```

These commands run on the trusted managed host. For a remote service, use an
SSH loopback forward and `connect --endpoint http://127.0.0.1:LOCAL_PORT`;
bootstrap connections currently require loopback HTTP. After changing the
installed generation, reconnect with `--output-directory NEW_DIRECTORY` and
select those new connection files. Existing connections are preserved. Keep
operator configurations and credentials on trusted hosts; workspace containers
receive only their scoped Git capabilities. The separate web package owns any
reviewer UI and browser authentication.

Start the optional reviewer UI without copying credentials from service JSON:

```bash
dim-reviewer-web init "$HOME/dim-control-plane/connections/reviewer.json" \
  --project example --output "$HOME/dim-reviewer.json"
dim-reviewer-web serve "$HOME/dim-reviewer.json"
```

The web package generates its own browser login; raw operator and service role
credentials stay server-side. The generated reviewer connection pins the exact
installed generation, so a service replacement requires reconnecting and
updating the UI configuration.
