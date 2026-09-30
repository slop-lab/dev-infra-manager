staging=$(mktemp -d "$output_parent/.monorepo-candidate.XXXXXX")
cleanup() {
  rm -rf -- "$staging"
}
trap cleanup EXIT

GIT_MASTER=1 git clone --quiet --no-local --no-checkout "$development_path" "$staging"
GIT_MASTER=1 git -C "$staging" checkout --quiet -b monorepo-candidate "$development_commit"
GIT_MASTER=1 git -C "$staging" remote remove origin
github_development_ref=refs/monorepo-sources/github-development
GIT_MASTER=1 git -C "$staging" fetch --quiet --no-tags "$github_development_path" \
  "$github_development_commit:$github_development_ref"
GIT_MASTER=1 git -C "$staging" cat-file -e "$github_development_ref^{commit}"
GIT_MASTER=1 git -C "$staging" cat-file -e "$github_development_ref^{tree}"
history_merge=$(printf 'Preserve GitHub development history at %s\n' "$github_development_commit" | \
  GIT_MASTER=1 git -C "$staging" -c user.name="DIM Monorepo Candidate" \
    -c user.email="monorepo-candidate@dim.invalid" commit-tree "${source_trees[development]}" \
    -p "$development_commit" -p "$github_development_ref")
GIT_MASTER=1 git -C "$staging" reset --quiet --hard "$history_merge"
if [[ "$(GIT_MASTER=1 git -C "$staging" show -s --format=%P HEAD)" != \
  "$development_commit $github_development_commit" ]]; then
  echo "GitHub development history merge does not have the required parents" >&2
  exit 1
fi
if [[ "$(GIT_MASTER=1 git -C "$staging" rev-parse 'HEAD^{tree}')" != "${source_trees[development]}" ]]; then
  echo "GitHub development history merge changed the selected development tree" >&2
  exit 1
fi

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
    for path in "${root_script_paths[@]}"; do
      if ! GIT_MASTER=1 git -C "$source_path" cat-file -e "$commit:$path" 2>/dev/null; then
        echo "root source does not contain required script: $path" >&2
        exit 2
      fi
    done
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
      cp -- "$overlay_snapshot/repository-materialization-smoke.bash" \
        "$staging/verification/scripts/repository-materialization-smoke.bash"
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
if ! GIT_MASTER=1 git -C "$staging" merge-base --is-ancestor "$github_development_commit" HEAD; then
  echo "GitHub development source commit is not candidate ancestry: $github_development_commit" >&2
  exit 1
fi
printf 'repository\tsource_commit\tsource_tree\tancestry_policy\n' \
  >"$candidate_evidence/github-development.tsv"
printf 'github-development\t%s\t%s\thistory-only-merge-parent\n' \
  "$github_development_commit" "$github_development_tree" \
  >>"$candidate_evidence/github-development.tsv"

GIT_MASTER=1 git -C "$staging" add .monorepo-candidate
GIT_MASTER=1 git -C "$staging" -c user.name="DIM Monorepo Candidate" \
  -c user.email="monorepo-candidate@dim.invalid" commit --quiet -m "Record monorepo candidate sources"
GIT_MASTER=1 git -C "$staging" fsck --full --no-reflogs >/dev/null
mv -- "$staging" "$output"
trap - EXIT

printf 'candidate=%s\n' "$output"
printf 'commit=%s\n' "$(GIT_MASTER=1 git -C "$output" rev-parse HEAD)"
