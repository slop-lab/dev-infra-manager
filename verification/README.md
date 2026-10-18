# Verification profiles

`pnpm --dir verification test` runs cross-package checks on an ordinary developer
host. It packages existing matched `dist` outputs when testing installation; it
does not rebuild shared packages. Run `just build-packages` first.

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
