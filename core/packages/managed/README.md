# Optional DIM managed services

`@slop-lab/dim-managed` owns optional native Project/Git integration,
review and CI workers, and explicitly selected host services. Base and native
workspaces use the same core store, selected runtime and lifecycle.

After preparing a native Project, create its workspace with the ordinary host
commands:

```bash
dim create dim://example development
dim ls
dim exec development -- git push origin
dim stop development
dim start development
dim recreate development
dim discard development
```

A Project owns independent repositories. Its configuration repository and default
working repository are selected separately. The local or SSH host acquires only
the chosen protected checkouts into `/workspace/REPOSITORY`, and attaches
repository-scoped Git capabilities. A configuration-only checkout is inspected
on the host and never seeded or granted to the guest. The broker
binds only the workspace's private bridge gateway, checks its immutable core
identity and current running state on every operation, and obtains short-lived
native Git leases. Operator credentials remain on the host. Proposal pushes
are scoped to that native workspace; protected refs remain review gated. Base
discard or workspace-name reuse immediately invalidates the old broker grant.
The broker exits after discard and is restored on managed workspace use after
a host restart.

Home, checkout and nested Docker data use the same core-owned storage as an
ordinary workspace. There is no privileged outer container, host socket mount,
automatic Project setup hook, or separate native workspace image. Run Project
setup and other tasks explicitly with `dim exec` inside that isolated runtime.

Managed Project state defaults to `~/.local/state/dim/managed`. Set
`DIM_MANAGED_STATE_ROOT` to select another managed state root. Ordinary
workspace state remains in the base workspace store. Native attachments live
under `native-workspace-attachments` in managed state and are keyed by the
core workspace UUID; they do not add native fields to core records.

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

`connect` verifies live Git service role identities and the exact generation before
writing `connections/host.json`, `registrar.json`, `importer.json`,
`reviewer.json`, `promoter.json` and `ci-query.json`. CI may be offline during
connection setup; `ci jobs` and `ci logs` verify its generation when used. Connecting
does not select a backend, start a host controller or install a UI. The initial host
connection supports Projects whose policies require no CI. Use the generated
connections to import an ordinary local repository. The connect command saves
the active host/importer paths privately in managed state; Project commands and
`dim create dim://PROJECT NAME` need no environment exports. Explicit
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` and
`DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE` overrides take precedence. For an SSH
workspace host, connect on that host so its own filesystem owns the selection.

```bash
dim managed project create example
dim managed project repository import example root \
  --source /absolute/path/to/repository \
  --ref refs/heads/main \
  --review-policy "$HOME/dim-control-plane/review-policy.json"
dim managed project configure example \
  --configuration-repository root --default-repository root
```

Repeat `repository import` with distinct repository IDs and review-policy files
for repositories such as `public` and `private`. Each policy names its repository
and explicitly lists `ciRepositoryIds`, including itself. A CI job can request
additional inputs only from that trusted allowlist. Import/readiness/review and
protected-ref promotion remain independent for every repository.

```bash
dim create dim://example combined \
  --repository public --repository private --workdir public
```

Without `--repository`, only the default working repository is checked out.
`--workdir` must name a selected repository. If an explicit subset excludes the
Project default, its first repository becomes the working directory. Configuration
still comes from the separately selected configuration repository; choosing a
working directory never changes the configuration authority.

These commands run on the trusted managed host. For a remote service, use an
SSH loopback forward and `connect --endpoint http://127.0.0.1:LOCAL_PORT`;
bootstrap connections currently require loopback HTTP. After changing the
installed generation, reconnect with `--output-directory NEW_DIRECTORY` and
the new connection becomes active on this host. Existing files are preserved. Keep
operator configurations and credentials on trusted hosts; workspace containers
receive only their scoped Git capabilities. The separate web package owns any
reviewer UI and browser authentication. On the next workspace start, restart,
recreate or shell/exec, an existing native attachment can adopt the newly
selected connection after fresh proof of its original authority, Project, ref
and review policy. Its checkout, grant and proposal namespace stay unchanged.
An active selection for another authority applies to new workspaces; existing
workspaces retain their original connection. An explicit
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` override to another authority, or a
change to the pinned policy, fails without rewriting the attachment.

Install the separate optional web package, then start the reviewer UI without
copying credentials from service JSON:

```bash
mise use --raw --global 'npm:@slop-lab/dim-web@0.10.0'
dim-web init "$HOME/dim-control-plane/connections/reviewer.json" \
  --project example --output "$HOME/dim-reviewer.json"
dim-web serve "$HOME/dim-reviewer.json"
```

The web package generates its own browser login; raw operator and service role
credentials stay server-side. The generated reviewer connection pins the exact
installed generation, so a service replacement requires reconnecting and
updating the UI configuration.

Native root CI hosts use direct registry access by default. No controller or
host-mirror plugin is required. An explicitly enabled host-mirror provider
selects the owned cache network, nested Docker mirror and read-only job
configuration for the selected runtime;
errors in that selected provider stop startup rather than changing routing.
