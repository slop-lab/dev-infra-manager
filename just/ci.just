set shell := ["bash", "-uc"]

# Node-only lane, after dependencies have been installed.
check:
    just check-source
    just verify plugin-install
    cd .. && pnpm audit --prod
    just verify package-packs

# Docker lane, after dependencies have been installed.
container:
    just check-source
    just verify container-ci
    cd .. && bash scripts/container-cgroup-smoke.bash

# Manually dispatched Sysbox lane, after dependencies have been installed.
sysbox:
    just check-source
    just verify container
    cd .. && bash scripts/container-sysbox-isolation-smoke.bash

# Manually dispatched KVM backend-installer lane.
kvm:
    test -r /dev/kvm -a -w /dev/kvm
    just verify environments-kvm

# Run the complete CI gate once with the active Node.js version.
all:
    just install-dependencies
    just ci check
    just verify container
    cd .. && bash scripts/container-cgroup-smoke.bash

# Reproduce hosted CI locally; pass --manual to include dispatched workflows.
matrix *args:
    cd .. && bash scripts/local-ci-matrix.bash {{args}}
