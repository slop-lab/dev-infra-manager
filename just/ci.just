set shell := ["bash", "-uc"]

# Supported-Node source compatibility lane, after dependencies have been installed.
source:
    just check-source
    just verify plugin-install
    cd .. && pnpm audit --prod
    just verify package-packs

# Managed workspace integration lane, after dependencies have been installed.
workspace:
    just check-source
    just verify workspace-runtime
    cd .. && bash scripts/container-cgroup-smoke.bash

# Manually dispatched Sysbox lane, after dependencies have been installed.
sysbox:
    just check-source
    just verify container
    cd .. && bash scripts/container-sysbox-isolation-smoke.bash

# KVM backend-installer lane; pass one backend to run an independent shard.
kvm backend="all":
    test -r /dev/kvm -a -w /dev/kvm
    just verify environments-kvm "{{backend}}"

# Run the complete CI gate once with the active Node.js version.
all:
    just install-dependencies
    just ci source
    just verify container
    cd .. && bash scripts/container-cgroup-smoke.bash

# Reproduce hosted CI locally; pass --manual to include dispatched workflows.
matrix *args:
    cd .. && bash scripts/local-ci-matrix.bash {{args}}
