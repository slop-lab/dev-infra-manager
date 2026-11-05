#!/bin/bash
set -euo pipefail
exec node scripts/checks/vm-runtime-acceptance.ts
