# Verification profiles

## Examples in fresh VMs

`.github/workflows/examples.yml` runs the `examples-vm` check on pull requests
targeting `main`, on merge groups targeting `main`, and on explicit manual
dispatches such as release candidates. It does not run on `development` pushes.
The ordinary Node 24/26 source checks in `verify.yml` still run on their existing
events; passing source checks alone does not establish VM example acceptance.

The examples workflow needs a disposable x86-64 self-hosted runner labeled
`dim-native-qemu`, with the host prerequisites documented in the
[fresh Ubuntu VM profile](bootstrap-ubuntu-vm.md#disposable-fresh-vm-acceptance-profile).
It requires readable/writable real `/dev/kvm`; missing KVM fails as unavailable,
and neither a successful skip nor TCG counts as a pass. An offline runner leaves
the required check pending. Use test hosts without production DIM state or
credentials. The workflow does not retain checkout credentials.

The same gate runs inside a DIM workspace with an explicit `container-kvm`
runtime grant. Start with `just verify examples-vm-preflight`; it tests actual
KVM VM creation as the current user and reports tool, memory and disk
requirements. The [workspace development guide](../../scripts/development.md#kvm-example-verification-inside-a-workspace)
shows installation and creation. No host Docker socket is passed into that
workspace. The ordinary `container` runtime does not expose KVM.

From a clean exact candidate in that workspace or on the test host, run:

```bash
DIM_EXAMPLES_VM_LOG_ROOT=/absolute/private/examples-evidence \
  bash scripts/checks/examples-vm-smoke.bash
```

The wrapper creates a Git bundle and manifest for the current commit and tree,
verifies `GITHUB_SHA` when supplied, and boots separate simultaneous Ubuntu
VMs for the control plane and DIM host. The control-plane VM installs only its
standalone runtime and declared control-plane plugins. The host VM installs the
host runtime and declared host plugins, connects to the remote service, and runs
the example `verify-vm` stages in its real Sysbox workspaces. The VMs have
independent disks, processes and DIM state. Their service connection crosses
the VM boundary through a host-key-pinned SSH tunnel; service listeners stay
on each VM's loopback interface. It is not an in-process
or same-VM substitute. The separate bootstrap profile still tests the
`ordinary` and `control-qemu` installation roles independently.

Cache routing is recorded in `cache-routing.json`. The gate discovers this
workspace's selected mirror URLs, or accepts `DIM_EXAMPLES_CACHE_CATALOG` with
the existing URL-only catalog schema. Missing selection is reported as `direct`;
it does not imply that a cache on the physical host is inherited. APT/npm/Docker
client configuration is applied before guest installation, and Docker selection
is bound to the bootstrap resume identity. Fixed Node/pnpm/Just/Sysbox downloads
are seeded from the outer content-addressed cache and verified again by each
installer. See the [cache setup and limits](../../scripts/development.md#kvm-example-verification-inside-a-workspace).
The outer invocation must succeed as well as its guest stages; teardown or
evidence-export failure is not acceptance. Logs remain under the selected
evidence directory, and the workflow uploads them even on failure. It uploads
`examples-vm-source-<SHA>` separately with the exact commit/tree evidence.

A maintainer must configure `examples-vm` as a required `main` branch check;
adding this workflow does not change repository rules. PR runs may test a
synthetic merge commit, and merge-queue runs test the queue's candidate rather
than the original PR head. Review the recorded commit/tree, not merely the
branch name or an older green run. Release candidates must repeat this gate
against their exact frozen commit/tree; see [releasing](../guides/releasing.md#required-verification).
The workflow event filters follow GitHub's
[merge-group branch syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onmerge_groupbranchesbranches-ignore).

## Source checks and logs

`just check-source` runs the same complete gate as GitHub CI in a disposable,
pinned Node 24 container: type checks, builds, tests, executable example recipes,
privileged service fixtures, package shapes and the production dependency audit. Select the other
supported lane with `DIM_SOURCE_NODE_MAJOR=26 just check-source`. Both lanes use
a fixed two-CPU container limit on local hosts and GitHub runners.
`just check-source-native` runs type checks, builds, ordinary tests and the
examples' lightweight `verify` stages with the installed supported
toolchain; it does not run privileged fixtures or VM example stages.

The terminal shows the current stage and a heartbeat every 30 seconds. Passing
command output stays in private per-stage logs under `.local/checks/run.*`.
Failures print the command's exit status, log path and last 160 lines; the
complete output remains in the file. Container logs are copied back before the
owned container is removed, including on failure. `DIM_CHECK_LOG_DIR=/path`
selects a different log parent. `DIM_CHECK_VERBOSE=1` also replays successful
stage output and enables the test runners' full reports. Outer-stage logs can
be tailed on the host immediately. Inner logs remain in the printed container
and `/tmp/dim-source-checks` directory until export; use `docker exec` with that
container name to inspect them while checks are running.

Direct Vitest commands omit passing test names and successful-test console
output by default, while retaining failure diagnostics and final counts. The
CLI’s Node reporter omits passing rows but preserves stdout/stderr that Node
cannot reliably attribute to a test result.
GitHub uploads per-lane source-check logs even on failure, separately from the
exact-source evidence. No installed DIM service or provider credential is needed
for this source gate.

`pnpm --dir tests test:scenarios` runs cross-package checks on an ordinary developer
host. It packages existing matched `dist` outputs when testing installation; it
does not rebuild shared packages. Run `just build-packages` first.

With an already built workspace image, run the explicit live container checks:

```bash
pnpm --dir tests exec tsx ../scripts/checks/base-workspace-runtime-smoke.mts IMAGE
just verify workspace-agent IMAGE
```

The optional [Tailscale gateway](../guides/tailscale.md) has a separate live check:

```bash
DIM_TAILNET_WORKSPACE_IMAGE=REVIEWED_LOCAL_WORKSPACE_IMAGE just verify tailscale-gateway
# Direct equivalent after checking local Docker, Sysbox, TUN and the selected image:
DIM_TAILNET_WORKSPACE_IMAGE=REVIEWED_LOCAL_WORKSPACE_IMAGE pnpm --dir tests exec tsx --conditions=dim-source scenarios/live/tailscaleGateway.e2e.ts
```

It creates a disposable Headscale tailnet and exercises the actual gateway,
workspace DNS/routing and nested-agent connectivity. It does not use host
Tailscale credentials, sockets or node state. Runtime prerequisites are checked
before the Just recipe starts the fixture.

The [public/private Project example](../../examples/projects/native-multiple-repositories/README.md)
is also exercised directly from its checked-in files:

```bash
pnpm --dir tests exec vitest run scenarios/execution/multipleRepositoryExample.test.ts
DIM_NATIVE_MULTI_REPOSITORY_IMAGE=REVIEWED_WORKSPACE_IMAGE pnpm --dir tests exec vitest run host/core/multiRepositoryWorkspaceRuntime.test.ts
```

The first command composes a disposable native Git service with the actual CI
workflow compiler plugin, imports the example's two independent Git trees and
reviewed policies, and runs its scripts against exact selected inputs. It needs
Git, Bash and `cmp`, with no provider login or installed control plane. The
second also needs host Docker, Sysbox and an existing reviewed workspace image;
it checks real proposal Git, selected directories, persistence through recreation
and public-only isolation, then removes its own workspaces. Its default skip in
source CI is not physical-runtime acceptance. Required plugins and services for
the other examples are listed in the [example verification matrix](../../examples/README.md#what-the-checks-establish).

The first checks owned storage, nested Docker, resource updates/unlimited,
private temporary data, SSH keys and registered service/session recovery through
stop/start/recreation. It also checks repeated nested exits for leaked zombie
processes and rejects missing initialized storage. The second uses the compiled
CLI and actual in-guest capability for assigned resources, CPU concurrency,
self restart/recreate and session continuation. Both create disposable resources
and discard their own workspace/storage. They do not modify installed DIM services.

CI execution has a separate live gate for both public runtime names:

```bash
pnpm --dir tests exec tsx ../scripts/checks/native-ci-runtime-smoke.mts container DIND_SUPERVISOR_IMAGE UBUNTU_IMAGE@sha256:DIGEST
pnpm --dir tests exec tsx ../scripts/checks/native-ci-runtime-smoke.mts vm QEMU_SUPERVISOR_IMAGE UBUNTU_IMAGE@sha256:DIGEST
```

Use the reviewed Docker-in-Docker base for the container supervisor. Build the
VM supervisor with `dim execution qemu-image IMAGE:TAG` or its source Dockerfile
under `packages/host/plugins/execution-worker/src/native-qemu-runner-assets`. The VM lane requires
KVM. Both lanes use an ordinary Ubuntu job image, install an OS package through
real DNS/egress, deliver read-only plugin configuration and verify workspace
output. The VM lane also checks that job root cannot remove its PID fence.
Image archives are extracted only inside the VM; the host never unpacks them.

The QEMU service ownership and process-safety fixtures require a root-owned,
canonical Node interpreter and root filesystem operations. Run
`pnpm --dir tests test:qemu-service` only in a disposable root environment.
This profile tests filesystem ownership, bounded subprocesses, startup, signal
handling and cleanup. It does not execute a VM or prove KVM availability.

For a local container run, use an immutable source-built execution scheduler service
image as `BASE_IMAGE`. Build a test-only tools image from that image ID:

```bash
docker build --build-arg BASE_IMAGE="$BASE_IMAGE" --tag dim-qemu-fixture-tools --file - . <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl openssh-client git procps && rm -rf /var/lib/apt/lists/*
DOCKERFILE

repo="$(pwd -P)"
cd tests
docker run --rm --init --network none --user 0:0 \
  --mount "type=bind,src=$repo,dst=$repo,readonly" \
  --tmpfs "$repo/tests/node_modules/.vite-temp:mode=1777" \
  --tmpfs "$repo/tests/node_modules/.vite:mode=1777" \
  --workdir "$repo/tests" --entrypoint /usr/local/bin/node \
  dim-qemu-fixture-tools node_modules/vitest/vitest.mjs run \
  --config vitest.privileged.config.ts --no-file-parallelism
```

The container receives no network, Docker socket, or KVM device. `--init` reaps
orphaned process groups so cleanup tests observe actual process termination.
Actual VM execution remains a separate hardware gate:
`just verify native-qemu-guest-mechanics-kvm` requires a capable disposable host.

`just verify native-idle-service-images` tests current service images.
`just verify installer-artifacts` installs matched tarballs through the real
facade into temporary prefixes. These are distinct checks: an image probe does
not prove a deployment transaction. Installer package tests separately cover
rollback, ownership and fail-before-mutation behavior.

Guest integration delivery has an additional disposable Sysbox check:

```bash
DIM_GUEST_INTEGRATION_IMAGE=sha256:REVIEWED_LOCAL_IMAGE_ID \
  pnpm --filter @this-project/tests exec vitest run --config vitest.config.ts \
  host/core/guestIntegrationRuntime.test.ts --maxWorkers=1
```

It creates an ordinary repository without `.dim`, checks unchanged-file reuse
and repair after recreation, then delivers to one explicitly selected nested
container while leaving another untouched. Its tiny nested Node image is made
from the reviewed workspace's existing binaries without a registry download.
The owned workspace, volumes, nested containers and image are discarded. This
tests the shared delivery path; plugin discovery and scoped requests have
separate real HTTP/client tests, and each integration retains its own behavior
checks. It does not install plugins into existing operator workspaces.
