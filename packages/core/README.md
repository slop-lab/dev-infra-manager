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
- `DIM_GITEA_IMAGE`, `DIM_GITEA_PORT`, and `DIM_GITEA_ADMIN_USERNAME`
- `DIM_GIT_USERNAME`
- the installed `workspaceBackend`, `DIM_WORKSPACE_IMAGE`, and
  `DIM_WORKSPACE_RUNTIME`
- `DIM_WORKSPACE_CPUS`, `DIM_WORKSPACE_MEMORY`, and `DIM_WORKSPACE_PIDS`
- `DIM_CI_RUNNER_IMAGE`, `DIM_CI_RUNNER_RUNTIME`, `DIM_CI_RUNNER_CPUS`,
  `DIM_CI_RUNNER_MEMORY`, and `DIM_CI_RUNNER_PIDS`

`DIM_CI_RUNNER_IMAGE` accepts exactly one of these forms:

- the built-in cache-tag sentinel `dev-infra-manager-ci-runner:act-runner-minimal-v1`,
  which DIM builds locally;
- a complete local Docker image ID such as `sha256:<64 lowercase hexadecimal characters>`;
- a tagless registry reference pinned as `name@sha256:<64 lowercase hexadecimal characters>`.

DIM pulls a configured registry reference and resolves it through Docker to the
actual local image ID. Runner probes, state, and launches use only that resolved
ID. Other tags and mutable image references are rejected before trusted image
execution.

The resource environment variables provide defaults. `createWorkspace`
accepts persistent per-workspace overrides. A Project root ref may be omitted;
workspace creation then resolves the root repository's symbolic `HEAD` and
fails if no `HEAD` exists.

The default state root is `~/.local/state/dim`; the default managed Gitea port
is `3300`. DIM does not migrate incompatible pre-stable state.

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
