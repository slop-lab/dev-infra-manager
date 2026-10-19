# Verification profiles

## Source checks and logs

`just check-source` runs the same complete gate as GitHub CI in a disposable,
pinned Node 24 container: type checks, builds, tests, privileged service
fixtures, package shapes and the production dependency audit. Select the other
supported lane with `DIM_SOURCE_NODE_MAJOR=26 just check-source`. Both lanes use
a fixed two-CPU container limit on local hosts and GitHub runners.
`just check-source-native` runs type checks, builds and ordinary tests directly
with the installed supported toolchain; it does not run privileged fixtures.

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

`pnpm --dir verification test` runs cross-package checks on an ordinary developer
host. It packages existing matched `dist` outputs when testing installation; it
does not rebuild shared packages. Run `just build-packages` first.

With an already built workspace image, run the explicit live container checks:

```bash
pnpm --dir tests exec tsx ../../scripts/checks/base-workspace-runtime-smoke.mts IMAGE
just verify workspace-agent IMAGE
```

The [public/private Project example](../../examples/projects/native-multiple-repositories/README.md)
is also exercised directly from its checked-in files:

```bash
pnpm --dir tests exec vitest run packages/core/test/ci/multipleRepositoryExample.test.ts
DIM_NATIVE_MULTI_REPOSITORY_IMAGE=REVIEWED_WORKSPACE_IMAGE pnpm --dir tests exec vitest run packages/core/test/multiRepositoryWorkspaceRuntime.test.ts
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
pnpm --dir tests exec tsx ../../scripts/checks/native-ci-runtime-smoke.mts container DIND_SUPERVISOR_IMAGE UBUNTU_IMAGE@sha256:DIGEST
pnpm --dir tests exec tsx ../../scripts/checks/native-ci-runtime-smoke.mts vm QEMU_SUPERVISOR_IMAGE UBUNTU_IMAGE@sha256:DIGEST
```

Use the reviewed Docker-in-Docker base for the container supervisor. Build the
VM supervisor with `dim ci qemu-image IMAGE:TAG` or its source Dockerfile
under `packages/host/plugins/ci-worker/src/native-qemu-runner-assets`. The VM lane requires
KVM. Both lanes use an ordinary Ubuntu job image, install an OS package through
real DNS/egress, deliver read-only plugin configuration and verify workspace
output. The VM lane also checks that job root cannot remove its PID fence.
Image archives are extracted only inside the VM; the host never unpacks them.

The QEMU service ownership and process-safety fixtures require a root-owned,
canonical Node interpreter and root filesystem operations. Run
`pnpm --dir verification test:qemu-service` only in a disposable root environment.
This profile tests filesystem ownership, bounded subprocesses, startup, signal
handling and cleanup. It does not execute a VM or prove KVM availability.

For a local container run, use an immutable source-built ordinary CI service
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
  scenarios/harness/qemu*.test.ts scenarios/harness/kvm*.test.ts scenarios/harness/bootstrapInstallerSafety.test.ts \
  --no-file-parallelism
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
  packages/core/test/guestIntegrationRuntime.test.ts --maxWorkers=1
```

It creates an ordinary repository without `.dim`, checks unchanged-file reuse
and repair after recreation, then delivers to one explicitly selected nested
container while leaving another untouched. Its tiny nested Node image is made
from the reviewed workspace's existing binaries without a registry download.
The owned workspace, volumes, nested containers and image are discarded. This
tests the shared delivery path; plugin discovery and scoped requests have
separate real HTTP/client tests, and each integration retains its own behavior
checks. It does not install plugins into existing operator workspaces.
