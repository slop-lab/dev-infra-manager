#!/usr/bin/env bash
set -euo pipefail

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "tty-required requires a terminal on stdin and stdout" >&2
  exit 1
fi

echo "tty-required-ok"
