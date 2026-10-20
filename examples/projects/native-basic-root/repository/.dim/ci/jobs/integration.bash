#!/usr/bin/env bash
set -euo pipefail
test -f README.md
test ! -e /dev/kvm
test ! -S /run/docker.sock
printf '%s\n' native-basic-qemu-ok
