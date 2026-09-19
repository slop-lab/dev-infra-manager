set shell := ["bash", "-uc"]

# Requires QEMU and writable /dev/kvm; installs Sysbox in one clean VM.
environments-kvm verbose="":
    cd .. && bash verification/scripts/kvm-host-install-smoke.bash "{{verbose}}"

# Installs DIM in a clean VM and proves an agent container can launch QEMU through the protected socket.
agent-control-kvm verbose="":
    cd .. && bash verification/scripts/qemu-agent-control-smoke.bash "{{verbose}}"

# Clean hosted/local gate. Missing x86-64, Docker, or writable KVM is unavailable (exit 2).
qemu-ci-image-layers-kvm:
    @[[ "$(uname -m)" == x86_64 ]] || { echo "qemu-ci-image-layers-kvm requires x86-64" >&2; exit 2; }
    @docker info >/dev/null 2>&1 || { echo "qemu-ci-image-layers-kvm requires a reachable Docker daemon" >&2; exit 2; }
    @[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || { echo "qemu-ci-image-layers-kvm requires an accessible character /dev/kvm" >&2; exit 2; }
    cd .. && DIM_QEMU_CI_KVM_SMOKE=1 pnpm --dir core-development exec vitest run packages/core/test/qemuCiRunnerKvm.test.ts

# Run the backend-independent end-to-end contract after a backend is installed.
full-development:
    just verify workspace-user-setup
    cd .. && DIM_EXAMPLE_WORKSPACE_BACKEND=sysbox JUST_UNSTABLE=1 bash verification/scripts/stateful-development-flow-smoke.bash
    cd .. && DIM_SELF_WORKSPACE_BACKEND=sysbox DIM_SELF_EXPECT_AGENT_UID=1001 DIM_SELF_VERIFY_AGENT=1 JUST_UNSTABLE=1 just verify self-development

# Build packages and verify plugin installation through the published package shape.
plugin-install:
    just build-packages
    cd .. && bash verification/scripts/plugin-install-smoke.bash

# Verify pinned workspace-user setup plus generic development-service exposure.
workspace-user-setup:
    cd .. && bash verification/scripts/workspace-user-setup-smoke.bash
    cd .. && bash verification/scripts/workspace-user-setup-remote-bootstrap-smoke.bash
    cd .. && bash verification/scripts/opencode-web-launcher-smoke.bash
    cd .. && bash verification/scripts/opencode-web-launcher-failure-smoke.bash
    cd .. && bash verification/scripts/opencode-web-real-runtime-smoke.bash

# Verify every publishable package through the same dry-run used before release.
package-packs:
    cd .. && pnpm --filter @slop-lab/dim-core run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-contracts-external-url run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-controller-proxy run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-plugin-external-urls run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-plugin-dns-cloudflare run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-cli run pack:dry-run
    cd .. && pnpm --filter @slop-lab/dim-installer run pack:dry-run

# Run the strongest gate supported inside this repository's DIM development agent.
agent:
    just check-source
    just verify plugin-install
    just verify package-packs
    just verify project-runtime-cgroups
    just verify pull-request-skill
    just verify agent-docker

# Verify the private rootless Docker runtime exposed to the development agent.
agent-docker:
    cd .. && bash verification/scripts/agent-docker-smoke.bash

# Prove cold, warm, and unavailable pull-through-cache routing with a disposable nested Docker daemon.
cache-routing-docker:
    cd .. && bash verification/scripts/registry-cache-routing-smoke.bash --docker-only
    cd .. && bash verification/scripts/registry-cache-routing-nested-smoke.bash --docker-only

# Clean hosted/local gate. Missing host-installed sysbox-runc is an unavailable capability (exit 2).
cache-routing-sysbox:
    cd .. && bash verification/scripts/registry-cache-routing-managed-smoke.bash --sysbox

# Clean hosted/local gate. Missing x86-64 KVM, QEMU, cloud-init, SSH, or socat is unavailable (exit 2).
cache-routing-kvm:
    cd .. && bash verification/scripts/registry-cache-routing-managed-smoke.bash --kvm

# Build the managed Sysbox runner image and prove Project tools, including Node.js, are absent.
sysbox-ci-runner-image:
    cd .. && bash verification/scripts/sysbox-ci-runner-image-smoke.bash

# Verify the systemd, cgroupfs, and unsupported Project runtime cgroup contracts.
project-runtime-cgroups:
    cd .. && bash verification/scripts/project-runtime-cgroups-example-smoke.bash

# Verify forge detection without relying on a live GitHub or Gitea instance.
pull-request-skill:
    cd .. && bash verification/scripts/pull-request-skill-smoke.bash

# Backend-independent container integration; requires cgroup-capable Docker for its nested runtime.
container:
    just verify workspace-runtime
    cd .. && bash verification/scripts/container-self-project-smoke.bash

# DIM-owned workspace runtime integration supported inside the Sysbox-isolated managed CI runner.
workspace-runtime:
    docker info >/dev/null
    docker compose version >/dev/null
    cd .. && bash verification/scripts/container-integration-preflight.bash
    just build-workspace-image
    cd .. && bash verification/scripts/container-inner-docker-smoke.bash
    cd .. && bash verification/scripts/container-lifecycle-smoke.bash
    cd .. && bash verification/scripts/container-packed-project-smoke.bash
    cd .. && bash verification/scripts/shared-upstream-example-smoke.bash

# Requires Docker and network access; exercises `mise use --raw --global npm:@slop-lab/dim-installer` in a disposable container.
mise-install-smoke:
    cd .. && bash verification/scripts/mise-install-smoke.bash

# Verify examples on the current host or in a separate disposable backend VM per example.
example backend="current-installed" dirty_repo="auto" example="all":
    cd .. && bash verification/scripts/verify-example.bash --backend "{{backend}}" --dirty-repo "{{dirty_repo}}" --example "{{example}}"

# Verify this repository's .dim contract with Docker and managed Gitea.
self-development:
    docker info >/dev/null
    docker compose version >/dev/null
    just build-packages
    just build-workspace-image
    cd .. && bash verification/scripts/container-self-project-smoke.bash

# Run generated workspace isolation checks without Docker or workspace creation.
isolation:
    cd .. && pnpm --dir core-development exec vitest run packages/core/test/lifecycleContainer.test.ts

# Run generated workspace isolation checks with Vitest's JSON reporter.
isolation-json:
    cd .. && pnpm --dir core-development exec vitest run packages/core/test/lifecycleContainer.test.ts --reporter=json
