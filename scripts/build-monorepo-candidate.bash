#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: bash scripts/build-monorepo-candidate.bash OUTPUT --github-development-source REPOSITORY FULL_COMMIT --source NAME REPOSITORY FULL_COMMIT [...]" >&2
  exit 2
}

repositories=(
  development
  root
  core
  core-development
  plugin-dns-cloudflare
  plugin-dns-cloudflare-development
  plugin-external-urls
  plugin-external-urls-development
  verification
  examples
  specification
)
root_script_paths=(
  scripts/build-monorepo-candidate.bash
  scripts/build-workspace-image.bash
  scripts/install-source-build.bash
  scripts/local-package-version.bash
  scripts/local-preparation-state.bash
  scripts/monorepo-candidate-assembly.bash
  scripts/pack-local-packages.mjs
  scripts/pack-source-build.bash
  scripts/prepare-source-build.bash
  scripts/monorepo-candidate-overlay
)
declare -A destinations=(
  [development]="."
  [root]="."
  [core]="core"
  [core-development]="core-development"
  [plugin-dns-cloudflare]="plugin-dns-cloudflare"
  [plugin-dns-cloudflare-development]="plugin-dns-cloudflare-development"
  [plugin-external-urls]="plugin-external-urls"
  [plugin-external-urls-development]="plugin-external-urls-development"
  [verification]="verification"
  [examples]="examples"
  [specification]="specification"
)
declare -A source_paths=()
declare -A source_commits=()
declare -A source_trees=()
github_development_path=
github_development_commit=
github_development_tree=

[[ "$#" -ge 1 ]] || usage
output=$1
shift
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
overlay="$script_dir/monorepo-candidate-overlay"
overlay_inputs=(
  CODEOWNERS repos.yml workspace-repositories.json reconcile-repositories.sh
  qemu-root-layout.patch adapt-verification-layout.bash repository-materialization-smoke.bash
  selfProjectTopologyPolicy.test.ts verify.yml release-gate.yml monorepo-candidate-evidence.mjs
)
overlay_targets=(
  .gitea/CODEOWNERS .dim/repos.yml .dim/workspace-repositories.json .dim/reconcile-repositories.sh
  git-apply verification-layout verification/scripts/repository-materialization-smoke.bash
  verification/test/selfProjectTopologyPolicy.test.ts .gitea/workflows/verify.yml
  .gitea/workflows/release-gate.yml verification/scripts/monorepo-candidate-evidence.mjs
)

while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--github-development-source" ]]; then
    [[ "$#" -ge 3 ]] || usage
    if [[ -n "$github_development_path" ]]; then
      echo "duplicate GitHub development source" >&2
      exit 2
    fi
    source_path=$2
    commit=$3
    shift 3

    if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
      echo "GitHub development commit must be exactly 40 lowercase hexadecimal characters" >&2
      exit 2
    fi
    if [[ ! -d "$source_path" ]]; then
      echo "GitHub development source repository does not exist: $source_path" >&2
      exit 2
    fi
    source_path=$(cd -- "$source_path" && pwd)
    if ! GIT_MASTER=1 git -C "$source_path" rev-parse --git-dir >/dev/null 2>&1; then
      echo "GitHub development source is not a Git repository: $source_path" >&2
      exit 2
    fi
    if [[ "$(GIT_MASTER=1 git -C "$source_path" rev-parse --is-shallow-repository)" == true ]] ||
      GIT_MASTER=1 git -C "$source_path" config --get-regexp '^remote\..*\.promisor$' 2>/dev/null | grep -Eq '[[:space:]]true$'; then
      echo "GitHub development source must contain complete history and blobs" >&2
      exit 2
    fi
    resolved_commit=$(GIT_MASTER=1 git -C "$source_path" rev-parse --verify "$commit^{commit}" 2>/dev/null) || {
      echo "GitHub development commit is unavailable: $commit" >&2
      exit 2
    }
    if [[ "$resolved_commit" != "$commit" ]]; then
      echo "GitHub development object is not the required commit: $commit" >&2
      exit 2
    fi
    github_development_path=$source_path
    github_development_commit=$commit
    github_development_tree=$(GIT_MASTER=1 git -C "$source_path" rev-parse "$commit^{tree}")
    continue
  fi

  [[ "$#" -ge 4 && "$1" == "--source" ]] || usage
  repository=$2
  source_path=$3
  commit=$4
  shift 4

  if [[ -z "${destinations[$repository]+present}" ]]; then
    echo "unknown source repository: $repository" >&2
    exit 2
  fi
  if [[ -n "${source_paths[$repository]+present}" ]]; then
    echo "duplicate source repository: $repository" >&2
    exit 2
  fi
  if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "$repository commit must be exactly 40 lowercase hexadecimal characters" >&2
    exit 2
  fi
  if [[ ! -d "$source_path" ]]; then
    echo "$repository source repository does not exist: $source_path" >&2
    exit 2
  fi

  source_path=$(cd -- "$source_path" && pwd)
  if [[ "$(GIT_MASTER=1 git -C "$source_path" rev-parse --is-inside-work-tree 2>/dev/null)" != true ]]; then
    echo "$repository source is not a Git worktree: $source_path" >&2
    exit 2
  fi
  resolved_commit=$(GIT_MASTER=1 git -C "$source_path" rev-parse --verify "$commit^{commit}" 2>/dev/null) || {
    echo "$repository commit is unavailable: $commit" >&2
    exit 2
  }
  if [[ "$resolved_commit" != "$commit" ]]; then
    echo "$repository object is not the required commit: $commit" >&2
    exit 2
  fi

  source_paths[$repository]=$source_path
  source_commits[$repository]=$commit
  source_trees[$repository]=$(GIT_MASTER=1 git -C "$source_path" rev-parse "$commit^{tree}")
done

if [[ -z "$github_development_path" ]]; then
  echo "missing GitHub development source" >&2
  exit 2
fi

for repository in "${repositories[@]}"; do
  if [[ -z "${source_paths[$repository]+present}" ]]; then
    echo "missing source repository: $repository" >&2
    exit 2
  fi
done

if [[ -e "$output" || -L "$output" ]]; then
  echo "output already exists: $output" >&2
  exit 2
fi
output_parent=$(dirname -- "$output")
output_name=$(basename -- "$output")
if [[ ! -d "$output_parent" || "$output_name" == "." || "$output_name" == ".." ]]; then
  echo "output parent must exist and output must name a new directory: $output" >&2
  exit 2
fi
output_parent=$(cd -- "$output_parent" && pwd)
output="$output_parent/$output_name"

development_path=${source_paths[development]}
development_commit=${source_commits[development]}
for repository in "${repositories[@]:1}"; do
  if [[ "$repository" == root ]]; then
    if GIT_MASTER=1 git -C "$development_path" cat-file -e "$development_commit:.dim" 2>/dev/null; then
      echo "development tree already owns Project contract destination: .dim" >&2
      exit 2
    fi
    for path in "${root_script_paths[@]}"; do
      if GIT_MASTER=1 git -C "$development_path" cat-file -e "$development_commit:$path" 2>/dev/null; then
        echo "development tree already owns Project script destination: $path" >&2
        exit 2
      fi
    done
    continue
  fi
  destination=${destinations[$repository]}
  if GIT_MASTER=1 git -C "$development_path" cat-file -e "$development_commit:$destination" 2>/dev/null; then
    echo "development tree already owns import destination: $destination" >&2
    exit 2
  fi
done
if GIT_MASTER=1 git -C "$development_path" cat-file -e "$development_commit:.monorepo-candidate" 2>/dev/null; then
  echo "development tree already owns candidate evidence path: .monorepo-candidate" >&2
  exit 2
fi
if GIT_MASTER=1 git -C "$development_path" cat-file -e "$development_commit:.gitea/CODEOWNERS" 2>/dev/null; then
  while IFS= read -r rule; do
    [[ -z "$rule" || "$rule" == \#* ]] && continue
    if ! grep -Fxq -- "$rule" "$overlay/CODEOWNERS"; then
      echo "candidate review policy would remove development CODEOWNERS rule: $rule" >&2
      exit 2
    fi
  done < <(GIT_MASTER=1 git -C "$development_path" show "$development_commit:.gitea/CODEOWNERS")
fi

source "$script_dir/monorepo-candidate-assembly.bash"
