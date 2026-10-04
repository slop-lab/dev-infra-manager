# Configuration

DIM stores installation-wide user settings in
`~/.config/dim/config.json` (or `DIM_CONFIG_PATH`) and schema-versioned
runtime state under `DIM_STATE_ROOT`. The host backend installer writes the
required `workspaceBackend` setting. If the CLI was installed separately, run
`dim doctor configure-backend`. It verifies locally usable backends before
recording one; when several are available, an interactive terminal prompts for
the choice.

The default paths use DIM's own namespace: configuration is under
`~/.config/dim`, persistent application state under `~/.local/state/dim`,
and installed data under `~/.local/share/dim`. DIM does not create files in
the organization-wide `slop-lab` directory.

The default managed-controller sockets are
`${XDG_RUNTIME_DIR:-/tmp/dim-UID}/dim/controller.sock` and `admin.sock`.
Only a non-default `DIM_STATE_ROOT` adds a stable state-root hash directory so
multiple controller instances cannot collide.

Common settings:

```text
DIM_STATE_ROOT
DIM_GITEA_IMAGE
DIM_GITEA_HOST
DIM_GITEA_PORT
DIM_GITEA_ADMIN_USERNAME
DIM_GITEA_ADMIN_PASSWORD
DIM_GITEA_CONNECTION_FILE
DIM_GIT_USERNAME
DIM_GIT_TOKEN
DIM_GIT_MAINTAINER_USERNAME
DIM_GIT_MAINTAINER_TOKEN
DIM_WORKSPACE_IMAGE
DIM_WORKSPACE_RUNTIME
DIM_WORKSPACE_PRIVILEGED
DIM_WORKSPACE_CPUS
DIM_WORKSPACE_MEMORY
DIM_WORKSPACE_PIDS
DIM_CI_RUNNER_IMAGE
DIM_CI_RUNNER_RUNTIME
DIM_CI_RUNNER_CPUS
DIM_CI_RUNNER_MEMORY
DIM_CI_RUNNER_PIDS
DIM_QEMU_SCHEDULER_CONNECTION_FILE
```

The following native control-plane host connection is a specified but
unimplemented target for a future Project/repository adapter. Current
controllers do not read or consume this variable, so setting it is ignored and
does not select native lifecycle or reject otherwise valid Gitea operations.
Do not rely on it in the current release. The target shape is one owner-only
file, not a set of command-line tokens:

```json
{
  "schemaVersion": 1,
  "hostId": "host-a",
  "nativeGit": {
    "transport": "https",
    "endpoint": "https://git-control.example",
    "serviceId": "native-main",
    "username": "host-a",
    "password": "replace-with-native-host-credential"
  },
  "ordinaryCi": {
    "transport": "https",
    "endpoint": "https://ci-control.example",
    "serviceId": "ordinary-main",
    "hostToken": "replace-with-host-token",
    "admissionToken": "replace-with-admission-token",
    "resultToken": "replace-with-result-token"
  },
  "capacities": {
    "primary": { "cpus": 4, "memoryBytes": 8589934592, "pids": 2048 }
  }
}
```

Create it as a regular, non-symlink, DIM-user-owned mode-`0600` file. HTTPS
origins contain no path or credentials. `loopback-http` is accepted only for a
loopback origin. All credentials are distinct and remain in the host
controller. Capacity names and limits are host installation policy; Projects
are not listed here and do not acquire persistent runner or image state.
After the future adapter exists, controller startup authenticates both service
identities before advertising capacity and never falls back to a local or
Project-scoped ordinary runner.

When target parsing is implemented before the adapter is available, a request
for native Project, repository, admission, or capacity behavior rejects before
mutation. This future fail-closed rule must not be read as current support for
or validation of the variable.

The future target file is mutually exclusive with `DIM_GITEA_CONNECTION_FILE`.
`DIM_ORDINARY_CI_POOL_CONNECTION_FILE` and the old schema-2 Gitea pool are
obsolete and rejected by the target. The optional QEMU scheduler file below is
Gitea-only; it neither supplies native ordinary CI, coexists with native
selection, nor joins the installer-owned Compose bundle.
The exact normative schema and authorities are in
[Configuration](../specs/03-configuration.md#native-control-plane-host-connection).

The Gitea settings below describe the currently implemented profile. The
unimplemented target native connection cannot select Project lifecycle, and a
future native adapter must define an explicit transition rather than treating
Gitea as an implicit fallback.

`DIM_GIT_USERNAME` and `DIM_GIT_TOKEN` identify the constrained writer exposed
to untrusted workspaces. `DIM_GIT_MAINTAINER_USERNAME` and
`DIM_GIT_MAINTAINER_TOKEN` identify the separate host-only credential used by
`dim x git` and `dim git setup`; they default to a generated token for the
`dim-host` identity. The host credential may push protected refs, while the
workspace writer remains excluded by branch protection. Neither credential is
embedded in repository URLs.

`DIM_GITEA_HOST` defaults to the hostname in a TCP `DOCKER_HOST`, or to
`127.0.0.1` for a local Docker daemon. Override it when the Docker daemon's
published ports are reachable through a different hostname or address.

Leave `DIM_GITEA_CONNECTION_FILE` unset for the existing DIM-managed local
Gitea container and generated credential lifecycle. Set it to a private
connection file to use an operator-managed external Gitea instance instead:

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

Create the file with mode `0600` under the DIM user's ownership. The four URLs
may differ so each client receives an endpoint reachable from its own network;
do not embed credentials in them. DIM checks `/version` and the authenticated
administrator identity, then uses the configured writer and maintainer
credentials through the existing URL-scoped Git helpers. The operator owns
service availability, users, organization creation, webhook target policy,
permissions, and branch protection. DIM neither provisions nor stops the
external service.

Use `https` except for loopback-only `loopback-http` or explicitly isolated
fixture or tunnel networks with `isolated-http`. The stable `hostId`
distinguishes provider registrations created by different hosts and must match
the shared QEMU scheduler host ID when that scheduler is configured. DIM
verifies that the administrator is an administrator and that the distinct
writer login is a non-administrator. The maintainer may reuse the administrator
credentials; a distinct maintainer login must be a non-administrator.
Host-admin `repo delete` and `project purge` requests delete external resources
after the ordinary usage and identity checks. This affects every host sharing
the repository or Project even though their independent local records remain.
Use `project remove` when only the current host should detach its local state.

Pre-create each external organization and copy its numeric Gitea ID into the
Project binding. Hosts that share a Project must share all three identity
values. DIM rejects an unbound Project and an organization whose numeric ID or
namespace differs, so a same-name organization is never adopted implicitly.

For QEMU capacity shared by multiple hosts, set
`DIM_QEMU_SCHEDULER_CONNECTION_FILE` to a DIM-user-owned mode-`0600` file on
each host. This mode requires external Gitea. Each host uses a distinct stable
`hostId` equal to its external Gitea connection `hostId`; every host for the
Project uses the same Project API token. The host ID is concurrency identity,
not authorization. The distinct central webhook token is configured in Gitea:

```json
{
  "schemaVersion": 1,
  "transport": "https",
  "hostId": "builder-a",
  "projects": {
    "acme": {
      "projectId": "copy-the-local-project-id",
      "controllerEndpoint": "https://scheduler-control.example",
      "supervisorEndpoint": "https://scheduler-workers.example",
      "webhookUrl": "https://scheduler-hooks.example/v1/webhooks/copy-the-local-project-id/workflow-job",
      "apiToken": "replace-with-project-api-token",
      "webhookToken": "replace-with-webhook-token"
    }
  }
}
```

Use `https` except for loopback-only (`loopback-http`) or explicitly isolated
networks (`isolated-http`). Endpoints contain no credentials. The service uses
separate project-webhook and Project API bearer tokens and receives no Gitea
administrator credential. Leaving the variable unset preserves host-local
scheduling; a Project cannot mix the two modes.

The packaged service caps each Project at 10,000 nonterminal jobs and 100,000
claim request receipts. Saturation rejects new state with HTTP `503` without
evicting existing claims or live fences. Terminal webhook delivery frees
nonterminal slots. Receipts without a live claim expire after seven days, so
normal release/reclaim churn recovers automatically after retention.

The standalone service config uses a minimum `leaseSeconds` of `60`. Each
Project entry includes `labels`, containing its QEMU integration labels such as
`dim-qemu`. The shared Project API credential may seed queued demand matching
these labels; running and completed transitions
require the Project webhook credential.

`DIM_WORKSPACE_IMAGE` explicitly overrides the trusted workspace image. When
unset, DIM selects `dev-infra-project-workspace:<installed package version>` so
the image follows the exact release or aggregate-identity local package set,
never a mutable `latest` tag.

Runtime backend selection is documented in
[Runtime Backends](runtime-backends.md). Project and workspace settings are
persisted by their lifecycle commands rather than copied into user config.
The CPU, memory, and PID settings are defaults for new workspace records.
`dim workspace create --cpus`, `--memory`, and `--pids` persist per-workspace
overrides. Change one or more limits on an existing workspace without
recreating it:

```bash
dim workspace resources WORKSPACE --cpus 4 --memory 8g --pids 2048
```

Omitted flags keep their recorded values. DIM updates the live or stopped
container first and persists the new effective limits only after Docker
accepts them.

The currently implemented predecessor Gitea runner profile retains these
legacy resource-default commands:

```bash
dim ci runner defaults set --cpus 6 --memory 12GiB --pids 4096
dim ci runner defaults show
dim ci runner defaults reset
```

They do not configure target native ordinary capacity. After a native Project
adapter exists, the target requires
one operator-selected digest-pinned `runnerBaseImage` and explicit positive
`cpus`, `memoryBytes`, `pids`, `timeoutSeconds`, and `outputBytes` for every
host-owned capacity in `DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE`. Candidate
schema-2 job config selects only its digest-pinned disposable job image and
fixed-shape script command; it cannot widen capacity bounds or replace the
runner base. There is no Project runner override or fallback.

DIM is pre-stable. Incompatible configuration and state are rejected rather
than migrated implicitly; compatibility behavior is added only when a release
explicitly defines it.
