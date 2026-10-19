#!/usr/bin/env bash
set -euo pipefail
test -s api-version.txt
test ! -e ../private
printf 'native-multiple-public-ok\n'
