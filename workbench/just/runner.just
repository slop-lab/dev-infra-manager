set shell := ["bash", "-uc"]

# Builds the pinned Sysbox + nested-KVM GitHub Actions QEMU base image.
build:
    cd .. && bash images/github-actions-runner-kvm/build.bash

# Boots the base image without registering it and exercises Sysbox + nested KVM.
verify:
    cd .. && bash images/github-actions-runner-kvm/run.bash --check

# Runs one ephemeral self-hosted Actions job, then deletes the VM overlay.
run:
    cd .. && bash images/github-actions-runner-kvm/run.bash
