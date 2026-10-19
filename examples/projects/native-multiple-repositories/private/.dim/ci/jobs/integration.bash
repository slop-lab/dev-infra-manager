#!/usr/bin/env bash
set -euo pipefail
cmp ../public/api-version.txt expected-public-version.txt
printf 'native-multiple-integration-ok\n'
