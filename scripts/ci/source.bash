#!/usr/bin/env bash
set -euo pipefail

# The runner starts the verified script copy in its repository checkout.
repository_root="$(pwd -P)"
# Tools belong to this disposable job, not the host or a Project runner image.
export PATH="$HOME/.local/dim-ci-tools/bin:$PATH"
if ! command -v pnpm >/dev/null 2>&1 || [[ "$(pnpm --version)" != 10.13.1 ]]; then
  npm install --global --prefix "$HOME/.local/dim-ci-tools" --ignore-scripts --no-audit --no-fund pnpm@10.13.1
fi
if ! command -v just >/dev/null 2>&1 || [[ "$(just --version)" != 'just 1.43.1' ]]; then
  bash "$repository_root/scripts/checks/source-gate/install-just.bash" "$HOME/.local/dim-ci-tools/bin"
fi

# Trusted acquisition supplies exact trees without host Git metadata. Tests that
# exercise Git-backed source tools need a job-local snapshot of those same bytes.
source_git_config_count="${GIT_CONFIG_COUNT:-0}"
case "$source_git_config_count" in
  0|[1-9]|[1-5][0-9]|6[0-3]) ;;
  *) printf 'source CI requires a decimal Git configuration count between 0 and 63\n' >&2; exit 2 ;;
esac
# Container root may differ from the owner of the verified bind-mounted tree.
# Scope this process and its Git children to this exact checkout, without files.
export "GIT_CONFIG_KEY_${source_git_config_count}=safe.directory"
export "GIT_CONFIG_VALUE_${source_git_config_count}=$repository_root"
export GIT_CONFIG_COUNT="$((source_git_config_count + 1))"
source_git() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$repository_root" \
    -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"
}
if [[ "$(source_git rev-parse --is-inside-work-tree 2>/dev/null || true)" != true ]]; then
  if [[ -e "$repository_root/.git" || -L "$repository_root/.git" ]]; then
    printf 'source CI refuses to replace existing unusable Git metadata\n' >&2
    exit 1
  fi
  source_git init --quiet --initial-branch=main
  source_git add --force --all
  source_git -c user.name=dim-source-ci -c user.email=source-ci@invalid commit --quiet --message source-ci-snapshot
fi
pnpm install --frozen-lockfile
pnpm run workspace:build
pnpm run workspace:check
pnpm run workspace:test
