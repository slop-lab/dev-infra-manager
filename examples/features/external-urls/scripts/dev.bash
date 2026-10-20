#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
node "$repo_root/scripts/examples/native-dev.ts" "$PWD"
"${DIM_BIN:-dim}" exec "${DIM_EXAMPLE_WORKSPACE:-external-urls-dev}" -- sh -c 'nohup bash server.bash > "$HOME/example-server.log" 2>&1 </dev/null &'
bash configure-ingress.bash
bash request-urls.bash "${DIM_EXAMPLE_WORKSPACE:-external-urls-dev}"
