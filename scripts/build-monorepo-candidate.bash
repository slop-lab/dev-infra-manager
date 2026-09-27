#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: bash scripts/build-monorepo-candidate.bash OUTPUT --source NAME REPOSITORY FULL_COMMIT [...]" >&2
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
  scripts/build-workspace-image.bash
  scripts/install-source-build.bash
  scripts/local-package-version.bash
  scripts/local-preparation-state.bash
  scripts/pack-local-packages.mjs
  scripts/pack-source-build.bash
  scripts/prepare-source-build.bash
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

[[ "$#" -ge 1 ]] || usage
output=$1
shift
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
overlay="$script_dir/monorepo-candidate-overlay"
overlay_inputs=(CODEOWNERS repos.yml workspace-repositories.json reconcile-repositories.sh qemu-root-layout.patch adapt-verification-layout.bash selfProjectTopologyPolicy.test.ts)
overlay_targets=(.gitea/CODEOWNERS .dim/repos.yml .dim/workspace-repositories.json .dim/reconcile-repositories.sh git-apply verification-layout verification/test/selfProjectTopologyPolicy.test.ts)

while [[ "$#" -gt 0 ]]; do
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
  echo "development tree already owns review policy destination: .gitea/CODEOWNERS" >&2
  exit 2
fi

staging=$(mktemp -d "$output_parent/.monorepo-candidate.XXXXXX")
cleanup() {
  rm -rf -- "$staging"
}
trap cleanup EXIT

GIT_MASTER=1 git clone --quiet --no-local --no-checkout "$development_path" "$staging"
GIT_MASTER=1 git -C "$staging" checkout --quiet -b monorepo-candidate "$development_commit"
GIT_MASTER=1 git -C "$staging" remote remove origin

candidate_evidence="$staging/.monorepo-candidate"
overlay_snapshot="$candidate_evidence/overlay"
mkdir -p -- "$overlay_snapshot"
overlay_manifest="$candidate_evidence/overlay.tsv"
printf 'input\ttarget\tsha256\n' >"$overlay_manifest"
for index in "${!overlay_inputs[@]}"; do
  input=${overlay_inputs[$index]}
  target=${overlay_targets[$index]}
  if [[ ! -f "$overlay/$input" || -L "$overlay/$input" ]]; then
    echo "overlay input must be a regular file: $overlay/$input" >&2
    exit 2
  fi
  cp -- "$overlay/$input" "$overlay_snapshot/$input"
  digest=$(sha256sum "$overlay_snapshot/$input")
  printf '%s\t%s\t%s\n' "$input" "$target" "${digest%% *}" >>"$overlay_manifest"
done
manifest_digest=$(sha256sum "$overlay_manifest")
printf '%s\n' "${manifest_digest%% *}" >"$candidate_evidence/overlay.digest"

for repository in "${repositories[@]:1}"; do
  source_path=${source_paths[$repository]}
  commit=${source_commits[$repository]}
  destination=${destinations[$repository]}
  source_ref="refs/monorepo-sources/$repository"

  GIT_MASTER=1 git -C "$staging" fetch --quiet --no-tags "$source_path" "$commit:$source_ref"
  GIT_MASTER=1 git -C "$staging" merge --quiet --allow-unrelated-histories --no-commit -s ours "$source_ref"
  if [[ "$repository" == root ]]; then
    if [[ "$(GIT_MASTER=1 git -C "$source_path" cat-file -t "$commit:.dim" 2>/dev/null)" != tree ]]; then
      echo "root source does not contain a .dim Project contract" >&2
      exit 2
    fi
    GIT_MASTER=1 git -C "$source_path" archive "$commit" .dim "${root_script_paths[@]}" | tar -x -C "$staging"
    cp -- "$overlay_snapshot/repos.yml" "$staging/.dim/repos.yml"
    cp -- "$overlay_snapshot/workspace-repositories.json" "$staging/.dim/workspace-repositories.json"
    cp -- "$overlay_snapshot/reconcile-repositories.sh" "$staging/.dim/reconcile-repositories.sh"
    GIT_MASTER=1 git -C "$staging" apply "$overlay_snapshot/qemu-root-layout.patch"
    mkdir -p -- "$staging/.gitea"
    cp -- "$overlay_snapshot/CODEOWNERS" "$staging/.gitea/CODEOWNERS"
    GIT_MASTER=1 git -C "$staging" add .dim .gitea/CODEOWNERS "${root_script_paths[@]}"
  else
    GIT_MASTER=1 git -C "$staging" read-tree --prefix="$destination/" -u "$source_ref^{tree}"
    if [[ "$repository" == verification ]]; then
      bash "$overlay_snapshot/adapt-verification-layout.bash" "$staging"
      cp -- "$overlay_snapshot/selfProjectTopologyPolicy.test.ts" \
        "$staging/verification/test/selfProjectTopologyPolicy.test.ts"
      GIT_MASTER=1 git -C "$staging" add verification
    fi
  fi
  GIT_MASTER=1 git -C "$staging" -c user.name="DIM Monorepo Candidate" \
    -c user.email="monorepo-candidate@dim.invalid" commit --quiet -m "Import $repository at $commit"
done

mapfile -d '' -t development_paths < <(
  GIT_MASTER=1 git -C "$staging" ls-tree -z --name-only "$development_commit"
)
if [[ "${#development_paths[@]}" -gt 0 ]]; then
  GIT_MASTER=1 git -C "$staging" diff --quiet "$development_commit" HEAD -- \
    "${development_paths[@]}" ':(exclude).gitea/CODEOWNERS' \
    "${root_script_paths[@]/#/:(exclude)}"
fi

evidence="$candidate_evidence/sources.tsv"
printf 'repository\tdestination\tsource_commit\tsource_tree\tcollision_policy\n' >"$evidence"
for repository in "${repositories[@]}"; do
  commit=${source_commits[$repository]}
  tree=${source_trees[$repository]}
  destination=${destinations[$repository]}
  policy=clear
  if [[ "$repository" == development ]]; then
    policy=root
  elif [[ "$repository" == root ]]; then
    policy=project-contract-overlay
  elif [[ "$repository" == verification ]]; then
    policy=candidate-verification-overlay
  else
    candidate_tree=$(GIT_MASTER=1 git -C "$staging" rev-parse "HEAD:$destination")
    if [[ "$candidate_tree" != "$tree" ]]; then
      echo "$repository candidate tree differs at destination $destination" >&2
      exit 1
    fi
  fi
  if ! GIT_MASTER=1 git -C "$staging" merge-base --is-ancestor "$commit" HEAD; then
    echo "$repository source commit is not candidate ancestry: $commit" >&2
    exit 1
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$repository" "$destination" "$commit" "$tree" "$policy" >>"$evidence"
done

GIT_MASTER=1 git -C "$staging" add .monorepo-candidate
GIT_MASTER=1 git -C "$staging" -c user.name="DIM Monorepo Candidate" \
  -c user.email="monorepo-candidate@dim.invalid" commit --quiet -m "Record monorepo candidate sources"
mv -- "$staging" "$output"
trap - EXIT

printf 'candidate=%s\n' "$output"
printf 'commit=%s\n' "$(GIT_MASTER=1 git -C "$output" rev-parse HEAD)"
