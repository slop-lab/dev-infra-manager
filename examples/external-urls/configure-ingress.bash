#!/usr/bin/env bash
set -euo pipefail

dim external-url add-ingress local-http \
  --driver builtin-http \
  --description "Local HTTP development URL" \
  --scheme http \
  --domain host.tail.test \
  --port 8080 \
  --listen-host 0.0.0.0 \
  --listen-port 8080
