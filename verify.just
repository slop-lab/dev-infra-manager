set shell := ["bash", "-uc"]

# Requires QEMU and writable /dev/kvm; installs Sysbox in one clean VM.
environments-kvm verbose="":
    cd .. && bash verification/scripts/kvm-host-install-smoke.bash "{{verbose}}"

# Run the backend-independent end-to-end contract after a backend is installed.
full-development:
    cd .. && DIM_EXAMPLE_WORKSPACE_BACKEND=sysbox JUST_UNSTABLE=1 bash verification/scripts/stateful-development-flow-smoke.bash
    cd .. && DIM_SELF_WORKSPACE_BACKEND=sysbox DIM_SELF_EXPECT_AGENT_UID=1001 DIM_SELF_VERIFY_AGENT=1 JUST_UNSTABLE=1 just verify self-development

# Build packages and verify plugin installation through the published package shape.
plugin-install:
    just build-packages
    cd .. && bash verification/scripts/plugin-install-smoke.bash

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

# Build the managed Sysbox runner image and prove host-mode JavaScript actions have Node.js.
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

# Run lifecycle isolation tests without Docker or workspace creation.
isolation:
    cd .. && pnpm --dir core-development exec vitest run packages/core/test/lifecycle.test.ts

# Run lifecycle isolation tests with Vitest's JSON reporter.
isolation-json:
    cd .. && pnpm --dir core-development exec vitest run packages/core/test/lifecycle.test.ts --reporter=json
