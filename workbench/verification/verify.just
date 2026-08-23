set shell := ["bash", "-uc"]

# Requires QEMU and writable /dev/kvm; uses one clean VM for the selected backend.
environments-kvm backend="all" verbose="":
    bash verification/scripts/kvm-host-install-smoke.bash "{{backend}}" "{{verbose}}"

# Build packages and verify plugin installation through the published package shape.
plugin-install:
    just build-packages
    bash verification/scripts/plugin-install-smoke.bash

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
    bash verification/scripts/agent-docker-smoke.bash

# Verify the systemd, cgroupfs, and unsupported Project runtime cgroup contracts.
project-runtime-cgroups:
    bash verification/scripts/project-runtime-cgroups-example-smoke.bash

# Verify forge detection without relying on a live GitHub or Gitea instance.
pull-request-skill:
    bash verification/scripts/pull-request-skill-smoke.bash

# Backend-independent container integration; requires cgroup-capable Docker for its nested runtime.
container:
    just verify workspace-runtime
    bash verification/scripts/container-self-project-smoke.bash

# DIM-owned workspace runtime integration supported inside the Sysbox-isolated managed CI runner.
workspace-runtime:
    docker info >/dev/null
    docker compose version >/dev/null
    bash verification/scripts/container-integration-preflight.bash
    just build-workspace-image
    bash verification/scripts/container-inner-docker-smoke.bash
    bash verification/scripts/container-lifecycle-smoke.bash
    bash verification/scripts/container-packed-project-smoke.bash
    bash verification/scripts/shared-upstream-example-smoke.bash

# Requires Docker and network access; exercises `mise use --raw --global npm:@slop-lab/dim-installer` in a disposable container.
mise-install-smoke:
    bash verification/scripts/mise-install-smoke.bash

# Verify examples on the current host or in a separate disposable backend VM per example.
example backend="current-installed" dirty_repo="auto" example="all":
    bash verification/scripts/verify-example.bash --backend "{{backend}}" --dirty-repo "{{dirty_repo}}" --example "{{example}}"

# Verify this repository's .dim contract with Docker and managed Gitea.
self-development:
    docker info >/dev/null
    docker compose version >/dev/null
    just build-packages
    just build-workspace-image
    bash verification/scripts/container-self-project-smoke.bash

# Run lifecycle isolation tests without Docker or workspace creation.
isolation:
    cd .. && pnpm --filter @slop-lab/dim-core exec vitest run test/lifecycle.test.ts

# Run lifecycle isolation tests with Vitest's JSON reporter.
isolation-json:
    cd .. && pnpm --filter @slop-lab/dim-core exec vitest run test/lifecycle.test.ts --reporter=json
