# Native Git and CI administration

Explicit host plugins and control-plane operator tools provide Native Git,
Project and CI administration.
Ordinary Git workspaces use the base CLI and do not need this package. Native
Projects attach to the same workspace runtime and lifecycle through `dim://`
sources.

## Installation

Install the reviewed version of the optional component alongside the CLI:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.10.0'
dim installer install core --with-managed
dim doctor
```

Linux, Git, Docker and `sysbox-runc` are required for workspaces. Optional
control-plane services use Docker Compose and a systemd user manager. QEMU CI
requires accessible `/dev/kvm`. Mirror, DNS and external URL plugins are optional;
this profile does not enable them or start the host controller.

## Native control plane

Prepare private operator configuration from exact reviewed image digests, review
it, install the services, then connect to their live generation:

```bash
dim control-plane prepare "$HOME/dim-control-plane" \
  --native-git-image 'registry.example/dim-native-git@sha256:REVIEWED_DIGEST' \
  --ordinary-ci-image 'registry.example/dim-ordinary-ci@sha256:REVIEWED_DIGEST'
dim installer install control-plane --config "$HOME/dim-control-plane/install.json"
dim control-plane connect "$HOME/dim-control-plane"
```

`connect` attests each service role, writes private host, registrar, importer,
reviewer and promoter connections, and selects the host/importer files on this
host. Project and `dim://` workspace commands then need no environment exports.
Use `--output-directory NEW_DIRECTORY` when connecting a new service generation.
Existing native workspaces adopt that connection on their next start, restart,
recreate or shell/exec only after proving the same control-plane authority,
Project, protected ref and review policy. Their checkout and Git identity stay
unchanged. A connection to another authority cannot retarget an existing
workspace.

The generated files contain credentials; retain their owner-only permissions.

Selection belongs to the executing host. Use `dim --host REMOTE
control-plane connect DIRECTORY` before `dim --host REMOTE create dim://demo
work-1`. The local
client does not transfer its control-plane credentials. Explicit
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` and
`DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE` override the saved selection for an
individual process; their service, host and generation must agree.

The installer creates services, not Projects, approvals, CI capacity or reviewer
UI deployments.

## CI capacity

One execution service and worker protocol handle Sysbox and QEMU slots. For an
initial local Sysbox worker, add its identity, slot count and reviewed images when
preparing a fresh deployment:

```bash
dim control-plane prepare "$HOME/dim-control-plane" \
  --native-git-image 'registry.example/dim-native-git@sha256:REVIEWED_DIGEST' \
  --ordinary-ci-image 'registry.example/dim-ordinary-ci@sha256:REVIEWED_DIGEST' \
  --ci-worker local-ci --ci-container-slots 1 \
  --ci-runner-image 'registry.example/sysbox-runner@sha256:REVIEWED_DIGEST' \
  --ci-job-image 'registry.example/job-environment@sha256:REVIEWED_DIGEST'
dim installer install control-plane --config "$HOME/dim-control-plane/install.json"
dim control-plane connect "$HOME/dim-control-plane"
dim ci worker "$HOME/dim-control-plane/connections/worker.json"
```

Preparing generates the service's matching worker token and slots. Connecting
writes an owner-only `worker.json` bound to the live generation and prints the
exact worker command. It starts no process. Without explicit worker/slot options,
the prepared service has no capacity and no worker file is emitted.

The Sysbox runner image must provide Docker's `dockerd-entrypoint.sh` and client;
the separate job image provides Bash and the Project's development tools.
The common Sysbox profile bounds each slot to 1 CPU, 2 GiB memory, 512 PIDs,
15 minutes and 1 MiB output. Use `--ci-container-profile FILE` instead of runner/job
image flags to supply an explicit profile with different reviewed bounds.
QEMU capacity requires `--ci-vm-slots COUNT --ci-vm-profile FILE` and a capable
KVM host; it does not fall back to emulation. Both runtimes may share this worker.

For a different worker host, copy only its generated `worker.json` with mode
0600. Keep deployment role files on the control-plane host. Establish authenticated
SSH forwards on the worker host matching the file's loopback Git/CI endpoints;
`connect --ci-worker-state-directory /absolute/worker/path` chooses its private
state path before copying. The default state path is `worker-state` beneath the
prepared deployment directory. Reconnect after a service generation update and
replace the worker file before restarting the worker.

For an explicitly configured worker, run:

```bash
dim ci worker /absolute/operator/worker.json
dim ci qemu-image registry.example/qemu-supervisor:reviewed
```

The owner-only host file binds a worker, installed generation, endpoints, owned
state directory and fixed slots. Service configuration owns slot runtime profiles,
reviewed image digests and resource bounds. Candidate files cannot select host
credentials, mounts, devices or fallback executors. Docker and required
Sysbox/KVM access are checked before claiming work. Mirrors are optional; an
explicitly enabled provider must reconcile successfully.

A durable request/result journal supports retries and cleanup recovery. Expired
leases remain fenced until cleanup is known. Git publication retries separately
from durable result acceptance and capacity reuse. No separate QEMU scheduler or
Project-scoped runner exists. See [execution setup](../../../../../docs/guides/ci-runners.md).

Read recent execution summaries and one execution's diagnostics on the selected
host:

```bash
dim --host devbox managed ci jobs
dim --host devbox managed ci jobs --json
dim --host devbox managed ci logs EXECUTION_ID
dim --host devbox managed ci logs EXECUTION_ID --json
```

`control-plane connect` writes an owner-only `ci-query.json` beside the saved
host connection. Query commands use it by default; `--connection FILE` selects
another private query connection. Connecting does not require the CI service to
be online. Use `connect --ci-endpoint http://127.0.0.1:PORT` for a separate SSH
forward to CI. Actual queries require the exact connected service generation
and a distinct read-only credential, never a worker token.

The list contains at most 100 recent summaries and no raw logs or execution
grants. Logs retain at most 64 KiB per stdout/stderr stream; text output preserves
bytes on their original streams and reports truncation. JSON includes result
metadata and base64 prefixes. A cleaned result can still await Git publication;
the list shows publication separately from execution outcome.

`connect` also writes a separate owner-only `ci-operator.json` for trusted
operations clients. The generation-bound operator API exposes configured worker
slot occupancy at `GET /v1/operator/workers` and accepts
`POST /v1/operator/jobs/EXECUTION_ID/cancel` with `{}` or `/retry` with
`{"requestId":"UUID"}`. Replaying a retry request returns the same execution.
Only the latest finished execution can be retried. Cancellation blocks renewals
and keeps a running slot fenced until its worker confirms cleanup; a racing
success is retained as diagnostics but cannot become accepted Git evidence.
Slot occupancy does not imply worker liveness. Query credentials cannot mutate
executions, and operator credentials cannot act as workers.

## Projects and workspaces

Create a Project identity, import independently reviewed repositories, then
select configuration and working defaults. Registrar/importer files are inferred
beside the selected host connection; explicit connection flags can override them
only within the same attested authority and generation.

```bash
dim project create demo --project-id demo
dim project repository import demo root \
  --source "$PWD/project-root" --ref refs/heads/main \
  --review-policy "$HOME/dim-control-plane/review-policy.json" --json
dim project configure demo \
  --configuration-repository root --default-repository root --json
dim project repository list demo --json
dim project list --json
dim project show demo --json
```

Each import has its own durable draft, bundle, receipt, protected ref and policy.
An interrupted or failed second import does not reset an already ready repository.
There is no Project-wide multi-repository promotion transaction. Creation/import
proves no CI result or human approval.

A trusted review-policy file has this shape (use matching IDs for each import):

```json
{
  "schemaVersion": 1,
  "repositoryId": "public",
  "review": {
    "ciRepositoryIds": ["public"],
    "requiredReviewerIds": ["owner"],
    "requiredJobs": []
  }
}
```

The allowlist is operator policy. A candidate CI job may request additional
repository inputs only from it; a public job cannot grant itself access to a
private repository by editing workflow code.

Create and operate native workspaces through the base commands:

```bash
dim image build
dim create dim://demo work-1
dim create dim://demo combined --repository public --repository private --workdir public
dim exec combined -- git status
dim exec combined -- git -C /workspace/private status
dim ls --json
dim resources work-1 --cpus 4 --memory 8g --pids 4096
dim stop work-1
dim start work-1
dim recreate work-1
dim discard work-1 --yes
```

The `combined` example assumes those repositories were separately imported.
Without explicit selection, only the default working repository is checked out.
Each selected repository lives at `/workspace/REPOSITORY`. `--workdir` selects one
of them; if an explicit subset excludes the Project default, the first selected
repository is used. The configuration repository is attested independently. If
unselected, it is read on the host for workspace configuration/plugin requirements
and is absent from guest storage and grants.

Each checkout receives a distinct repository-bound broker credential and proposal
namespace. Direct protected updates, deletes, forced updates, tags and foreign
repository/workspace scopes are denied. A repository named `public` does not
implicitly allow anonymous native Git reads. Operator credentials remain on the
host. Recreate preserves mutable checkouts and grants; reconnect requires fresh
proof of every attached repository's original authority, ref and review policy.
Base owns the lifecycle for ordinary and native workspaces alike.

## Reviewer UI

The web package is an optional separate installation. Use its connection-bound
configuration rather than copying service credentials into browser code:

```bash
mise use --raw --global 'npm:@slop-lab/dim-web@0.10.0'
dim-web init "$HOME/dim-control-plane/connections/reviewer.json" \
  --project demo-root --output "$HOME/dim-reviewer.json" --port 8789
dim-web serve "$HOME/dim-reviewer.json"
```

Review approval and protected-ref promotion remain separate authority roles.

## Host state

Ordinary and native-attached workspace records share the base store under
`~/.local/state/dim`. `DIM_STATE_ROOT` selects another base store. Managed Project
records, pending imports, plugin configuration and the active control-plane
selection default to `~/.local/state/dim/managed`; `DIM_MANAGED_STATE_ROOT`
selects another managed directory. An explicit `DIM_STATE_ROOT` also supplies
the managed location when no managed-specific override is present.

Optional plugin administration uses `dim controller` and its host-owned
Unix sockets. Workspace-scoped requests use core workspace UUID grants and do
not expose a controller socket or runtime credentials inside containers.

DIM is pre-stable. Obsolete configuration and state are rejected instead of
being silently adopted. Export required data with the prior pinned version
before starting fresh.

See the [workspace guide](../../../../../docs/guides/project-workspaces.md)
and [plugin guide](../../../../../docs/guides/plugins.md).
