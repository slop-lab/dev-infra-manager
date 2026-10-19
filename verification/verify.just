set shell := ["bash", "-uc"]

# Requires QEMU and writable /dev/kvm; installs Sysbox in one clean VM.
environments-kvm verbose="":
    cd .. && bash verification/scripts/kvm-host-install-smoke.bash "{{verbose}}"

# Real KVM guest mechanics on the current host. This is not independent-host or human release acceptance.
native-qemu-guest-mechanics-kvm:
    @[[ "$(uname -m)" == x86_64 ]] || { echo "native-qemu-guest-mechanics-kvm requires x86-64" >&2; exit 2; }
    @docker info >/dev/null 2>&1 || { echo "native-qemu-guest-mechanics-kvm requires a reachable Docker daemon" >&2; exit 2; }
    @[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || { echo "native-qemu-guest-mechanics-kvm requires an accessible character /dev/kvm" >&2; exit 2; }
    cd .. && bash verification/scripts/native-qemu-guest-mechanics-kvm-smoke.bash

# Real native ordinary executor Docker integration; nested execution requires explicit digest-pinned Sysbox fixture images.
native-ordinary-executor-live:
    @docker info >/dev/null 2>&1 || { echo "native-ordinary-executor-live requires a reachable Docker daemon" >&2; exit 2; }
    @docker info 2>/dev/null | grep -Eq '^ Runtimes:.*sysbox-runc' || { echo "native-ordinary-executor-live requires sysbox-runc" >&2; exit 2; }
    @[[ "${DIM_TEST_NATIVE_RUNNER_IMAGE:-}" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "native-ordinary-executor-live requires DIM_TEST_NATIVE_RUNNER_IMAGE as a digest reference" >&2; exit 2; }
    @[[ "${DIM_TEST_NATIVE_JOB_IMAGE:-}" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "native-ordinary-executor-live requires DIM_TEST_NATIVE_JOB_IMAGE as a digest reference" >&2; exit 2; }
    @docker image inspect "$DIM_TEST_NATIVE_RUNNER_IMAGE" >/dev/null 2>&1 || { echo "native-ordinary-executor-live requires the runner fixture image locally" >&2; exit 2; }
    @docker image inspect "$DIM_TEST_NATIVE_JOB_IMAGE" >/dev/null 2>&1 || { echo "native-ordinary-executor-live requires the job fixture image locally" >&2; exit 2; }
    cd .. && pnpm --dir verification exec vitest run --config live/vitest.config.ts live/nativeOrdinaryExecutorLive.test.ts

# Build private digest-pinned fixtures and run one real Sysbox job on the current host.
native-ordinary-guest-mechanics:
    cd .. && bash verification/scripts/native-ordinary-guest-mechanics-smoke.bash

# Build an isolated fixture and exercise a real native Project, persistent Sysbox workspace, and proposal-only Git authority.
native-basic-lifecycle:
    @docker info >/dev/null 2>&1 || { echo "native-basic-lifecycle requires a reachable Docker daemon" >&2; exit 2; }
    @docker info 2>/dev/null | grep -Eq '^ Runtimes:.*sysbox-runc' || { echo "native-basic-lifecycle requires sysbox-runc" >&2; exit 2; }
    cd .. && bash verification/scripts/native-basic-lifecycle-live.bash

# Shipped full-development entrypoint for independent native contracts, services, Sysbox, and real-KVM stages.
full-development:
    cd .. && bash verification/scripts/kvm-guest-verification-smoke.bash

# Exercise dependency-aware verification aggregation without Docker or KVM.
verification-stage-runner:
    cd .. && bash verification/scripts/verification-stage-runner-test.bash

# Build packages and verify plugin installation through the published package shape.
plugin-install:
    just build-packages
    cd .. && bash verification/scripts/plugin-install-smoke.bash

# Prove raw TCP reachability across a disposable Headscale tailnet without host Tailscale state.
headscale-tailnet-tcp:
    cd .. && bash verification/scripts/headscale-tailnet-tcp-smoke.bash

# Verify pinned user tools and authenticated loopback development services.
workspace-user-setup:
    cd .. && bash verification/scripts/workspace-user-setup-smoke.bash
    cd .. && bash verification/scripts/codex-user-setup-smoke.bash
    cd .. && bash verification/scripts/opencode-web-launcher-smoke.bash
    cd .. && bash verification/scripts/opencode-web-launcher-failure-smoke.bash
    cd .. && bash verification/scripts/opencode-web-real-runtime-smoke.bash

# Verify every publishable package through the same dry-run used before release.
package-packs:
    cd .. && pnpm --filter @slop-lab/dim-core run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-managed run pack:dry-run
    cd .. && bash scripts/packages/pnpm-pack-dry-run.bash packages/control-plane/plugins/ci-workflows/dist
    cd .. && pnpm --filter @slop-lab/dim-contracts-external-url run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-plugin-control-plane-native-git run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-web run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-plugin-external-urls run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-plugin-dns-cloudflare run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-plugin-host-mirrors run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-plugin-cache-server run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-cli run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-installer run pack:dry-run

# Run the strongest gate supported inside this repository's DIM development agent.
agent:
    just check-source
    just verify plugin-install
    just verify package-packs
    just verify pull-request-skill
    just verify agent-docker

# Verify the private rootless Docker runtime exposed to the development agent.
agent-docker:
    cd .. && bash verification/scripts/agent-docker-smoke.bash

# Prove the dedicated agent TMPDIR volume lifecycle on the host runc Docker backend.
agent-temp-volume-docker:
    cd .. && bash verification/scripts/agent-temporary-volume-smoke.bash

# Prove cold, warm, and unavailable pull-through-cache routing with a disposable nested Docker daemon.
cache-routing-docker:
    cd .. && bash verification/scripts/registry-cache-routing-smoke.bash --docker-only
    cd .. && bash verification/scripts/registry-cache-routing-nested-smoke.bash --docker-only

# Build and probe the two native control-plane idle service images without runtime authority.
native-idle-service-images:
	cd .. && bash verification/scripts/native-idle-service-images-smoke.bash

# Install matched built tarballs through the real facade into disposable prefixes.
installer-artifacts:
    cd .. && pnpm --dir verification exec vitest run test/localSourceInstaller.test.ts test/targetInstallerSelection.test.ts --no-file-parallelism

# Verify GitHub forge detection offline.
pull-request-skill:
    cd .. && bash verification/scripts/pull-request-skill-smoke.bash

# Backend-independent container integration; requires cgroup-capable Docker for its nested runtime.
container phases="":
    just verify workspace-runtime

# Exercise the production single-container runtime with owned disposable storage.
workspace-runtime:
    just build-local-workspace-image
    cd .. && image_version="$(bash verification/scripts/local-build-version.bash)" && node --import ./tests/node_modules/tsx/dist/loader.mjs verification/scripts/base-workspace-runtime-smoke.mts "dev-infra-project-workspace:$image_version"

# Exercise compiled CLI guest capabilities and session continuation with an existing image.
workspace-agent image:
    cd .. && node --import ./tests/node_modules/tsx/dist/loader.mjs verification/scripts/base-workspace-agent-smoke.mts "{{image}}"

# Exercise ordinary CI job images and dependency installation in a real runtime.
ci-runtime runtime supervisor image:
    cd .. && node --import ./tests/node_modules/tsx/dist/loader.mjs verification/scripts/native-ci-runtime-smoke.mts "{{runtime}}" "{{supervisor}}" "{{image}}"

# Exercise optional workspace capabilities through the bounded base transport.
controller-workspace-relay-smoke image:
    cd .. && node verification/scripts/controller-workspace-relay-smoke.mjs "{{image}}"

# Requires Docker and network access; exercises `mise use --raw --global npm:@slop-lab/dim-installer` in a disposable container.
mise-install-smoke:
    cd .. && bash verification/scripts/mise-install-smoke.bash

# Run generated workspace isolation checks without Docker or workspace creation.
isolation:
    cd .. && pnpm --dir tests exec vitest run packages/core/test/workspaceService.test.ts

# Run generated workspace isolation checks with Vitest's JSON reporter.
isolation-json:
    cd .. && pnpm --dir tests exec vitest run packages/core/test/workspaceService.test.ts --reporter=json

# Install exact source artifacts into temporary prefixes and verify optional profiles.
local-bundle-profiles bundle:
    cd .. && node verification/scripts/local-bundle-profiles-smoke.mjs "{{bundle}}"
