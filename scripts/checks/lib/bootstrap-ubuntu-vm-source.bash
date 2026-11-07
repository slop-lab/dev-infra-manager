bootstrap_source_usage() {
  cat <<'EOF'
Usage:
  bash scripts/checks/bootstrap-ubuntu-vm-smoke.bash \
    --source-bundle BUNDLE --source-manifest MANIFEST
  bash scripts/checks/bootstrap-ubuntu-vm-smoke.bash \
    --source-bundle BUNDLE --source-sha SHA --source-tree TREE

The manifest accepts schemaVersion 1, sourceSha, sourceTree and optional boundedParents.
Bounded input declares exactly all immediate parents (one to eight), not arbitrary history.
All paths must be absolute regular files. SHA and tree values are full lowercase
40-hex Git object IDs.
EOF
}

bootstrap_source_parse() {
  local manifest=""
  SOURCE_BUNDLE=""
  SOURCE_SHA=""
  SOURCE_TREE=""
  SOURCE_BOUNDED_PARENTS=""
  while (($#)); do
    case "$1" in
      --source-bundle)
        [[ $# -ge 2 ]] || { printf '%s\n' '--source-bundle requires a value' >&2; return 2; }
        SOURCE_BUNDLE="$2"; shift 2 ;;
      --source-manifest)
        [[ $# -ge 2 ]] || { printf '%s\n' '--source-manifest requires a value' >&2; return 2; }
        manifest="$2"; shift 2 ;;
      --source-sha)
        [[ $# -ge 2 ]] || { printf '%s\n' '--source-sha requires a value' >&2; return 2; }
        SOURCE_SHA="$2"; shift 2 ;;
      --source-tree)
        [[ $# -ge 2 ]] || { printf '%s\n' '--source-tree requires a value' >&2; return 2; }
        SOURCE_TREE="$2"; shift 2 ;;
      --help|-h)
        bootstrap_source_usage
        return 64 ;;
      *)
        printf 'unknown argument: %s\n' "$1" >&2
        return 2 ;;
    esac
  done
  bootstrap_source_regular_file "$SOURCE_BUNDLE" bundle || return
  if [[ -n "$manifest" ]]; then
    [[ -z "$SOURCE_SHA" && -z "$SOURCE_TREE" ]] || {
      printf '%s\n' 'manifest and explicit source identity forms are mutually exclusive' >&2
      return 2
    }
    bootstrap_source_regular_file "$manifest" manifest || return
    bootstrap_source_read_manifest "$manifest" || return
  fi
  [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
    printf '%s\n' 'source SHA must be exactly 40 lowercase hexadecimal characters' >&2
    return 2
  }
  [[ "$SOURCE_TREE" =~ ^[0-9a-f]{40}$ ]] || {
    printf '%s\n' 'source tree must be exactly 40 lowercase hexadecimal characters' >&2
    return 2
  }
  export SOURCE_BUNDLE SOURCE_SHA SOURCE_TREE SOURCE_BOUNDED_PARENTS
}

bootstrap_source_regular_file() {
  local path="$1" label="$2"
  [[ "$path" == /* && -f "$path" && ! -L "$path" ]] || {
    printf '%s must be an absolute regular non-symlink file\n' "$label" >&2
    return 2
  }
}

bootstrap_source_read_manifest() {
  local manifest="$1" parsed
  local helper="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/source-manifest.ts"
  parsed="$(node "$helper" read "$manifest")" || return 2
  read -r SOURCE_SHA SOURCE_TREE SOURCE_BOUNDED_PARENTS <<<"$parsed"
}
# Shared by the operator validator and fresh guest consumer. No Node is needed
# in the pristine guest. The raw candidate commits bind the only allowed boundary.
bootstrap_source_import_bundle() {
  local root="$1" bundle="$2" sha="$3" tree="$4" bounded="$5" actual_tree actual_parents objects expected git_dir
  git -C "$root" bundle verify "$bundle" >/dev/null || return
  if [[ -n "$bounded" ]]; then
    [[ "$bounded" =~ ^[a-f0-9]{40}(,[a-f0-9]{40}){0,7}$ ]] || { echo 'invalid bounded source parents' >&2; return 2; }
    git -C "$root" bundle unbundle "$bundle" >/dev/null || return
    [[ "$(git -C "$root" cat-file -t "$sha")" == commit ]] || return 2
    actual_parents="$(git -C "$root" cat-file commit "$sha" | sed -n '/^$/q;s/^parent //p' | paste -sd ,)"
    [[ "$actual_parents" == "$bounded" ]] || { echo 'bounded source parents do not match raw candidate' >&2; return 2; }
    # Reject a misleading bounded manifest carrying extra commit ancestry.
    objects="$(git -C "$root" cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)' | awk '$2 == "commit" {print $1}' | LC_ALL=C sort)"
    expected="$(printf '%s\n' "$sha" "${bounded//,/$'\n'}" | LC_ALL=C sort -u)"
    [[ "$objects" == "$expected" ]] || { echo 'bounded source contains commits outside its immediate context' >&2; return 2; }
    git_dir="$(git -C "$root" rev-parse --absolute-git-dir)"
    [[ ! -e "$git_dir/shallow" && ! -L "$git_dir/shallow" ]] || return 2
    printf '%s\n' "${bounded//,/$'\n'}" >"$git_dir/shallow"
    chmod 0600 "$git_dir/shallow"
  fi
  git -C "$root" -c fetch.fsckObjects=true fetch --quiet --no-tags "$bundle" "$sha" || return
  [[ "$(git -C "$root" rev-parse FETCH_HEAD)" == "$sha" ]] || { echo 'source bundle did not resolve declared source SHA' >&2; return 2; }
  actual_tree="$(git -C "$root" rev-parse 'FETCH_HEAD^{tree}')"
  [[ "$actual_tree" == "$tree" ]] || { echo 'source bundle tree differs from declared tree' >&2; return 2; }
  git -C "$root" update-ref refs/heads/dim-bootstrap-source "$sha" || return
  git -C "$root" symbolic-ref HEAD refs/heads/dim-bootstrap-source || return
  git -C "$root" fsck --strict --full --no-reflogs --no-progress || return
}
bootstrap_source_verify_bundle() {
  local validation_root="$1"
  mkdir -m 0700 "$validation_root"
  git -C "$validation_root" init --bare --quiet
  bootstrap_source_import_bundle "$validation_root" "$SOURCE_BUNDLE" "$SOURCE_SHA" "$SOURCE_TREE" "$SOURCE_BOUNDED_PARENTS"
}
