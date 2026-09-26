# @slop-lab/dim-core

Core TypeScript APIs behind the `dim` command-line interface. This package
implements:

- Project and project-scoped repository state;
- managed Gitea reconciliation and clone URLs;
- provider-neutral Project CI runner lifecycle with an initial managed-Gitea
  coordinator adapter and isolated container executor;
- persistent workspace create/start/restart/update/discard lifecycle;
- a Sysbox workspace runtime plan with runc reserved for trusted infrastructure;
- host-readiness checks;
- plugin manifest loading and version validation.

Most users should install
[`@slop-lab/dim-cli`](https://www.npmjs.com/package/@slop-lab/dim-cli)
instead. The core package is for embedding DIM lifecycle operations in
TypeScript tools or contributing to DIM itself.

## Installation

Pin the same reviewed release used by the CLI:

```bash
npm install --save-exact "@slop-lab/dim-core@0.9.0"
```

The package is ESM-only, supports Node.js 24 and 26, and includes TypeScript
declarations. It supports Linux hosts only.

Lifecycle operations require a mounted Linux procfs and the util-linux
`flock` executable. DIM combines the kernel guard with a versioned owner
record so process death releases exclusion while PID reuse remains detectable.

## Basic use

```ts
import {
  ProcessRunner,
  createProject,
  importProjectRepository,
  createWorkspace,
  lifecycleOptions
} from "@slop-lab/dim-core";

const runner = new ProcessRunner();
const options = lifecycleOptions(process.env);

await createProject(runner, options, "acme");
await importProjectRepository(runner, options, {
  project: "acme",
  alias: "root",
  source: "/path/to/acme",
  root: true,
  ref: "main",
  protectedPatterns: ["main", "development"]
});
await createWorkspace(runner, options, {
  project: "acme",
  name: "feature-123",
  runtimeBackend: "sysbox",
  profiles: [],
  cpuCount: "4",
  memory: "8g",
  pidsLimit: "4096"
});
```

Lifecycle methods reconcile Docker containers, volumes, networks, and a local
managed Gitea service. They are not pure data helpers. Callers must provide a
usable host environment and surface `UserError` messages to users without
discarding the underlying operation result.

`importProjectRepository` is a low-level mirror import and copies every source
ref. Applications that want the CLI's branches-and-tags-only default should
use the prepare/transfer/complete API and perform that explicit Git transfer
with host credentials.

## Configuration

`lifecycleOptions()` reads the same environment used by the CLI:

- `DIM_STATE_ROOT`
- `DIM_GITEA_IMAGE`, `DIM_GITEA_PORT`, and `DIM_GITEA_ADMIN_USERNAME` for the
  default host-local managed service
- `DIM_GITEA_CONNECTION_FILE` for an operator-managed external Gitea service
- `DIM_GIT_SYNC_CONNECTION_FILE` for the separately deployed Git-host sync service
- `DIM_GIT_USERNAME`
- the installed `workspaceBackend`, `DIM_WORKSPACE_IMAGE`, and
  `DIM_WORKSPACE_RUNTIME`
- `DIM_WORKSPACE_CPUS`, `DIM_WORKSPACE_MEMORY`, and `DIM_WORKSPACE_PIDS`
- `DIM_CI_RUNNER_IMAGE`, `DIM_CI_RUNNER_RUNTIME`, `DIM_CI_RUNNER_CPUS`,
  `DIM_CI_RUNNER_MEMORY`, and `DIM_CI_RUNNER_PIDS`

`DIM_CI_RUNNER_IMAGE` accepts exactly one of these forms:

- the built-in cache-tag sentinel `dev-infra-manager-ci-runner:act-runner-minimal-v2`,
  which DIM builds locally;
- a complete local Docker image ID such as `sha256:<64 lowercase hexadecimal characters>`;
- a tagless registry reference pinned as `name@sha256:<64 lowercase hexadecimal characters>`.

DIM pulls a configured registry reference and resolves it through Docker to the
actual local image ID. Runner probes, state, and launches use only that resolved
ID. Other tags and mutable image references are rejected before trusted image
execution.

Without `DIM_WORKSPACE_IMAGE`, the workspace image is
`dev-infra-project-workspace:<installed DIM package version>`. Release installs
therefore select the release tag, while aggregate-identity local packages
select their full local version tag. `DIM_WORKSPACE_IMAGE` remains an explicit
override.

`buildWorkspaceImage` stages the image Dockerfile, entrypoint, relay, and
cgroup helpers shipped in this package together with the exact-version
`@slop-lab/dim-controller-proxy` dependency, then runs Docker Buildx with the
current user's UID and GID. It accepts only an explicit mutable tag as a build
destination: image IDs, digest references, untagged references, and `latest`
are rejected. The operation is local to Docker and does not require or start a
DIM controller.

The resource environment variables provide defaults. `createWorkspace`
accepts persistent per-workspace overrides. A Project root ref may be omitted;
workspace creation then resolves the root repository's symbolic `HEAD` and
fails if no `HEAD` exists.

The default state root is `~/.local/state/dim`; the default managed Gitea port
is `3300`. DIM rejects incompatible pre-stable state except for the single
lossless host lifecycle transition from schema 1 to schema 2. At controller
startup, `migrateHostLifecycleState` runs under the host lifecycle lock before
plugins or listeners, renames only `resumeCiRunners` to `restartCiRunners`, and
retains the original bytes permanently in mode-`0600`
`host.json.schema-1.bak`. Normal lifecycle reads remain schema-2-only. A
malformed record, extra field, conflicting backup, symlink, or non-regular
canonical, backup, or recognized temporary artifact fails closed without
changing canonical state. No Project, workspace, runner, plugin, installer, or
other state is migrated.

When `DIM_GITEA_CONNECTION_FILE` is set, the mode-`0600`, DIM-user-owned JSON
file is the complete external connection boundary:

```json
{
  "schemaVersion": 1,
  "transport": "https",
  "hostId": "builder-a",
  "apiBaseUrl": "https://gitea-control.example/api/v1",
  "hostBaseUrl": "https://git.example",
  "workspaceBaseUrl": "https://git.workspace.example",
  "runnerBaseUrl": "https://git.runner.example",
  "credentials": {
    "adminUsername": "dim-operator",
    "adminPassword": "replace-with-secret",
    "writerUsername": "dim-workspace",
    "writerPassword": "replace-with-secret",
    "maintainerUsername": "dim-host",
    "maintainerPassword": "replace-with-secret"
  },
  "projects": {
    "acme": {
      "id": "shared-project-id",
      "gitNamespace": "dim-acme",
      "giteaOrganizationId": 42
    }
  }
}
```

The API, host-clone, workspace-clone, and runner endpoints are independent
because those clients may use different routes to the same service. DIM
requires HTTPS unless every endpoint is loopback HTTP or the operator selects
`isolated-http` for an isolated network. It rejects redirects and bounds API
requests to the configured API base. The administrator must report admin
status; the writer must be a distinct non-admin identity. The maintainer may
reuse the administrator credentials, while a distinct maintainer must report
non-admin status. DIM does not create or stop the external service, create
credentials, change its organization-creation policy, or rewrite its webhook
allowlist. Host-admin repository deletion and Project purge do delete external
resources after the ordinary checks, affecting every host attached to the
shared Project even though their local records remain. Use `project remove` to
detach only local state. The operator must provision the users, organization,
permissions, and branch policy first. Each external Project requires a unique
explicit shared ID, namespace, and Gitea organization ID; this lets multiple
hosts attach to the same Project without adopting an unrelated same-name
organization. The stable host ID scopes and persists Sysbox provider
registrations across hosts.

Repository fetch and publish do not run in the DIM controller or a temporary
clone. Build the version-pinned service image with
`dim repo sync-service image build IMAGE`, deploy it beside Gitea repository
storage, and point `DIM_GIT_SYNC_CONNECTION_FILE` at a private connection file.
The service has a separate private alias registry and transport allowlist; it
receives no arbitrary command or caller-selected filesystem path. Absence of
the connection file makes synchronization fail closed. Initial `repo add`
imports remain local host Git operations.

Every managed CI runner requires `.dim/ci/runner.yml` in the protected Project
root. Its strict schema declares ordinary and integration labels,
digest-pinned disposable job images, required executables, and the integration
workload's `nested-docker` capability. DIM records the exact source ref, commit,
and configuration digest, probes both workloads before registration, and never
runs Project workflow commands in the runner host container.

For QEMU CI capacity, a Project may provide `.dim/ci/qemu-cache.bash`. DIM
requires applied root protection, resolves the configured root or symbolic
`HEAD` once to a concrete protected branch and commit, and stages the exact
hook blob from that immutable commit. An absent hook stages a deterministic
no-op executable instead of an empty sentinel. The resolved source ref,
commit, kind, and executable digest define the Project image identity and are
stored in runner state. DIM executes the staged bytes as root inside the Packer
guest, passing `/var/lib/dim-kvm-cache` as the only argument. The hook does not
run on the host and receives no host runtime socket or coordinator credential.
Reconcile the QEMU capacity after changing it.

The shared QEMU common base pins one dated, signed Ubuntu 24.04 cloud image and
one timestamped Ubuntu snapshot. Its identity includes exact artifact URLs and
digests, signer-keyring provenance, APT source and requested package/version
specifications, downloaded executable inputs, generated scripts, and Packer
templates. Ubuntu guarantees snapshot history for at least two years rather
than forever; preserve those source artifacts in a reviewed internal immutable
cache when rebuilds must remain possible beyond that period.

## API scope

The package exports its core modules from the root entry point, including
lifecycle records and low-level managed-Gitea helpers. APIs are versioned with
DIM but are not promised to remain source-compatible across minor `0.x`
releases. Prefer high-level functions from `projectRegistry`,
`workspaceLifecycle`, and `ciRunner` over direct state or Gitea mutation.

The plugin loader validates explicitly installed plugins and gives each
controller an instance-scoped plugin route registry. `GET /api` discovers
those authenticated routes. Core does not define product-specific external
URL routes or a generic repository-provider extension point.

DIM executes Project-controlled lifecycle scripts and manages container
runtimes. Consumers must follow the mandatory
[adoption and trust requirements](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/adoption.md),
including full human review and exact version pinning.

See the
[architecture](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/architecture.md),
[lifecycle documentation](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/repo-workspaces.md),
and [source repository](https://github.com/slop-lab/dev-infra-manager).
