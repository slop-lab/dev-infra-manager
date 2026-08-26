#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
checkout_root="$(git -C "$repo_root" rev-parse --show-toplevel)"
# shellcheck source=lib/git-clone-source.bash
source "$script_dir/lib/git-clone-source.bash"

backend="current-installed"
dirty_policy="auto"
selection="all"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --backend)
      backend="${2:?--backend requires a value}"
      shift 2
      ;;
    --dirty-repo)
      dirty_policy="${2:?--dirty-repo requires a value}"
      shift 2
      ;;
    --example)
      selection="${2:?--example requires a value}"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
usage: verification/scripts/verify-example.bash [--backend BACKEND] [--dirty-repo POLICY] [--example EXAMPLE]

BACKEND:
  current-installed | sysbox

EXAMPLE:
  all | single-repository | multi-repository | full-development-flow | ci-runner | external-urls | shared-upstream | project-runtime-cgroups

POLICY:
  auto     reject a dirty source repository
  use      include tracked and untracked working-tree changes
  discard  verify committed HEAD without changing the working tree
EOF
      exit 0
      ;;
    -*)
      echo "unknown option: $1" >&2
      exit 2
      ;;
    *)
      if [[ "$backend" == current-installed ]]; then
        backend="$1"
      elif [[ "$dirty_policy" == auto ]]; then
        dirty_policy="$1"
      elif [[ "$selection" == all ]]; then
        selection="$1"
      else
        echo "too many positional arguments" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

case "$backend" in
  current-installed|sysbox) ;;
  *) echo "unsupported example backend: $backend" >&2; exit 2 ;;
esac
case "$dirty_policy" in
  auto|use|discard) ;;
  *) echo "dirty repository policy must be auto, use, or discard" >&2; exit 2 ;;
esac
case "$selection" in
  all|single-repository|multi-repository|full-development-flow|ci-runner|external-urls|shared-upstream|project-runtime-cgroups) ;;
  *) echo "example must be all, single-repository, multi-repository, full-development-flow, ci-runner, external-urls, shared-upstream, or project-runtime-cgroups" >&2; exit 2 ;;
esac
work_dir="$(mktemp -d /tmp/dim-example-verification.XXXXXX)"
cleanup() {
  find "$work_dir" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

dim_prepare_clone_source "$checkout_root" "$work_dir/source" "$dirty_policy"
verification_checkout="$DIM_GIT_CLONE_SOURCE"
verification_source="$verification_checkout/workbench"

if [[ "$backend" != current-installed ]]; then
  if [[ "$selection" == all || "$selection" == project-runtime-cgroups ]]; then
    echo "example[$backend]: verify project-runtime-cgroups contract"
    bash "$verification_source/verification/scripts/project-runtime-cgroups-example-smoke.bash"
    if [[ "$selection" == project-runtime-cgroups ]]; then
      exit
    fi
  fi
  export DIM_KVM_IMAGE_CACHE="${DIM_KVM_IMAGE_CACHE:-$repo_root/.local/kvm}"
  if [[ "$selection" == all ]]; then
    qemu_examples=(single-repository multi-repository full-development-flow external-urls shared-upstream)
    qemu_examples+=(ci-runner)
  else
    qemu_examples=("$selection")
  fi
  for example in "${qemu_examples[@]}"; do
    bash "$verification_source/verification/scripts/example-qemu-smoke.bash" \
      "$backend" "$verification_checkout" "$example"
  done
  exit
fi

cd "$verification_source"
if [[ ! -d node_modules/.pnpm ]]; then
  pnpm install --frozen-lockfile
fi

if [[ "$selection" == all ]]; then
  examples=(single-repository multi-repository full-development-flow external-urls shared-upstream project-runtime-cgroups)
  if docker info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"'; then
    examples+=(ci-runner)
  else
    echo "example[current-installed]: skip ci-runner (sysbox-runc is unavailable)"
  fi
else
  examples=("$selection")
fi
if [[ "$selection" == ci-runner ]] &&
  ! docker info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"'; then
  echo "the ci-runner example requires sysbox-runc" >&2
  exit 2
fi
for example in "${examples[@]}"; do
  case "$example" in
    single-repository) smoke="single-repository-example-smoke.bash" ;;
    multi-repository) smoke="multi-repository-example-smoke.bash" ;;
    full-development-flow) smoke="stateful-development-flow-smoke.bash" ;;
    ci-runner) smoke="ci-runner-example-smoke.bash" ;;
    external-urls) smoke="external-url-example-smoke.bash" ;;
    shared-upstream) smoke="shared-upstream-example-smoke.bash" ;;
    project-runtime-cgroups) smoke="project-runtime-cgroups-example-smoke.bash" ;;
  esac
  echo "example[current-installed]: verify $example"
  bash "verification/scripts/$smoke"
done
