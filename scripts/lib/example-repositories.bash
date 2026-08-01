#!/usr/bin/env bash

dim_materialize_example_repositories() {
  local example_dir="$1"
  local target_dir="$2"
  local repositories_dir="$example_dir/repos"
  local source destination alias manifest temporary_manifest
  local -a aliases=()

  [[ -d "$repositories_dir" ]] || {
    echo "example has no repositories directory: $repositories_dir" >&2
    return 2
  }
  [[ ! -e "$target_dir" ]] || {
    echo "already exists: $target_dir" >&2
    return 2
  }

  mkdir -p "$target_dir"
  for source in "$repositories_dir"/*; do
    [[ -d "$source" ]] || continue
    alias="$(basename -- "$source")"
    aliases+=("$alias")
    destination="$target_dir/$alias"
    cp -R "$source" "$destination"
    git init --initial-branch=main "$destination" >/dev/null
    git -C "$destination" add -A
    git -C "$destination" commit -m "initial example-$alias" >/dev/null
  done
  [[ "${#aliases[@]}" -gt 0 ]] || {
    echo "example has no repository fixtures: $repositories_dir" >&2
    return 2
  }

  manifest="$target_dir/root/.dim/repos.yml"
  if [[ -f "$manifest" ]]; then
    temporary_manifest="$manifest.tmp"
    cp "$manifest" "$temporary_manifest"
    for alias in "${aliases[@]}"; do
      jq --arg alias "$alias" --arg url "$(realpath "$target_dir/$alias")" \
        '.repositories[$alias].url = $url' \
        "$temporary_manifest" >"$manifest"
      mv "$manifest" "$temporary_manifest"
    done
    mv "$temporary_manifest" "$manifest"
    git -C "$target_dir/root" add .dim/repos.yml
    git -C "$target_dir/root" commit --amend --no-edit >/dev/null
  fi
}

dim_register_example_repositories() {
  local project="$1"
  local repositories="$2"
  local dim_bin="${3:-dim}"
  local manifest="$repositories/root/.dim/repos.yml"

  if [[ -f "$manifest" ]]; then
    "$dim_bin" project create "$project" --repos "$manifest" --yes
  else
    "$dim_bin" project create "$project"
    "$dim_bin" repo add "$project" root "$repositories/root" \
      --root --ref main --protect main
  fi
}
