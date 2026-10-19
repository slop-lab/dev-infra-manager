# Verification profiles

`pnpm --dir verification test` runs cross-package checks on an ordinary developer
host. It packages existing matched `dist` outputs when testing installation; it
does not rebuild shared packages. Run `just build-packages` first.

With an already built workspace image, run the explicit live container checks:

```bash
pnpm --dir tests exec tsx ../verification/scripts/base-workspace-runtime-smoke.mts IMAGE
just verify workspace-agent IMAGE
```

The first checks owned storage, nested Docker, resource updates/unlimited,
private temporary data, SSH keys and registered service/session recovery through
stop/start/recreation. It also checks repeated nested exits for leaked zombie
processes and rejects missing initialized storage. The second uses the compiled
CLI and actual in-guest capability for assigned resources, CPU concurrency,
self restart/recreate and session continuation. Both create disposable resources
and discard their own workspace/storage. They do not modify installed DIM services.

CI execution has a separate live gate for both public runtime names:

```bash
pnpm --dir tests exec tsx ../verification/scripts/native-ci-runtime-smoke.mts container DIND_SUPERVISOR_IMAGE UBUNTU_IMAGE@sha256:DIGEST
pnpm --dir tests exec tsx ../verification/scripts/native-ci-runtime-smoke.mts vm QEMU_SUPERVISOR_IMAGE UBUNTU_IMAGE@sha256:DIGEST
```

Use the reviewed Docker-in-Docker base for the container supervisor. Build the
VM supervisor with `dim managed ci qemu-image IMAGE:TAG` or its source Dockerfile
under `core/packages/managed/src/native-qemu-runner-assets`. The VM lane requires
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
cd verification
docker run --rm --init --network none --user 0:0 \
  --mount "type=bind,src=$repo,dst=$repo,readonly" \
  --tmpfs "$repo/verification/node_modules/.vite-temp:mode=1777" \
  --tmpfs "$repo/verification/node_modules/.vite:mode=1777" \
  --workdir "$repo/verification" --entrypoint /usr/local/bin/node \
  dim-qemu-fixture-tools node_modules/vitest/vitest.mjs run \
  test/qemu*.test.ts test/kvm*.test.ts test/bootstrapInstallerSafety.test.ts \
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
