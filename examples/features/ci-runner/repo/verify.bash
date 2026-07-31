#!/usr/bin/env bash
set -euo pipefail

grep -qx 'hello from the managed CI runner example' message.txt
test -f .dim/repos.yml
echo "ci-runner-example-ok"
