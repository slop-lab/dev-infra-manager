#!/usr/bin/env bash
set -euo pipefail
# Explicitly exercises candidate code inside a disposable evaluator container.
exec bash scripts/verify-runtime.bash
