#!/usr/bin/env sh
set -eu

test "${DIM_WORKSPACE_KVM:-0}" = 1
test -r /dev/kvm
test -w /dev/kvm
printf '%s\n' "workspace-kvm-ok"
