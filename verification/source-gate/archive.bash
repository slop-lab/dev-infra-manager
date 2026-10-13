#!/usr/bin/env bash
set -euo pipefail

root="${1:?source root is required}"

exec tar --create --file - --directory "$root" \
  --exclude='.git' --exclude='*/.git' \
  --exclude='node_modules' --exclude='*/node_modules' \
  --exclude='dist' --exclude='*/dist' \
  --exclude='userstate' --exclude='*/userstate' \
  --exclude='.local' --exclude='*/.local' \
  --exclude='.gitcredentials' --exclude='*/.gitcredentials' \
  --exclude='.git-credentials' --exclude='*/.git-credentials' \
  --exclude='.docker' --exclude='*/.docker' \
  --exclude='.netrc' --exclude='*/.netrc' \
  --exclude='.ssh' --exclude='*/.ssh' \
  --exclude='.env' --exclude='.env.*' --exclude='*/.env' --exclude='*/.env.*' \
  --exclude='.npmrc' --exclude='*/.npmrc' \
  .
