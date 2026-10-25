#!/usr/bin/env bash
set -euo pipefail

# Only called in disposable Debian source-check containers. docker.io supplies
# the trusted CLI exercised by tests; this job never starts a Docker daemon.
if [[ "${1:-}" == --if-needed && $# == 1 ]]; then
  missing=false
  for tool in gcc g++ make curl git jq python3 ssh pgrep flock xz openssl; do
    command -v "$tool" >/dev/null 2>&1 || missing=true
  done
  [[ -x /usr/local/bin/docker || -x /usr/bin/docker ]] || missing=true
  if [[ "$missing" == false ]]; then exit 0; fi
elif (( $# != 0 )); then
  printf 'usage: install-system-tools.bash [--if-needed]\n' >&2
  exit 2
fi

[[ "$(id -u)" == 0 ]] || { printf 'missing source CI tools require a disposable root container\n' >&2; exit 1; }
# Official Debian container bases deny service autostart through this policy.
# Refuse installation if that guard is missing instead of changing host policy.
for service in docker containerd; do
  policy_status=0
  /usr/sbin/policy-rc.d "$service" start >/dev/null 2>&1 || policy_status=$?
  [[ "$policy_status" == 101 ]] || { printf 'source CI requires a policy denying service autostart\n' >&2; exit 1; }
done
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends \
  build-essential ca-certificates curl docker.io git jq libsqlite3-0 openssh-client \
  openssl procps python3 util-linux xz-utils
rm -rf /var/lib/apt/lists/*
