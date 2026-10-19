bootstrap_source_usage() {
  cat <<'EOF'
Usage:
  bash scripts/checks/bootstrap-ubuntu-vm-smoke.bash \
    --source-bundle BUNDLE --source-manifest MANIFEST
  bash scripts/checks/bootstrap-ubuntu-vm-smoke.bash \
    --source-bundle BUNDLE --source-sha SHA --source-tree TREE

The manifest form accepts exactly schemaVersion 1, sourceSha, and sourceTree.
All paths must be absolute regular files. SHA and tree values are full lowercase
40-hex Git object IDs.
EOF
}

bootstrap_source_parse() {
  local manifest=""
  SOURCE_BUNDLE=""
  SOURCE_SHA=""
  SOURCE_TREE=""
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
  export SOURCE_BUNDLE SOURCE_SHA SOURCE_TREE
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
  if ! parsed="$(node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const keys = Object.keys(value).sort();
const expected = ["schemaVersion", "sourceSha", "sourceTree"];
if (JSON.stringify(keys) !== JSON.stringify(expected) || value.schemaVersion !== 1
  || typeof value.sourceSha !== "string" || typeof value.sourceTree !== "string") {
  process.stderr.write("manifest must contain only schemaVersion, sourceSha, and sourceTree\\n");
  process.exit(2);
}
process.stdout.write(`${value.sourceSha} ${value.sourceTree}`);
' "$manifest")"; then
    return 2
  fi
  read -r SOURCE_SHA SOURCE_TREE <<<"$parsed"
}

bootstrap_source_verify_bundle() {
  local validation_root="$1" actual_tree
  mkdir -m 0700 "$validation_root"
  git -C "$validation_root" init --bare --quiet
  git -C "$validation_root" bundle verify "$SOURCE_BUNDLE" >/dev/null
  git -C "$validation_root" fetch --quiet --no-tags "$SOURCE_BUNDLE" "$SOURCE_SHA"
  [[ "$(git -C "$validation_root" rev-parse FETCH_HEAD)" == "$SOURCE_SHA" ]] || {
    printf '%s\n' 'source bundle did not resolve the declared source SHA' >&2
    return 2
  }
  actual_tree="$(git -C "$validation_root" rev-parse "FETCH_HEAD^{tree}")"
  [[ "$actual_tree" == "$SOURCE_TREE" ]] || {
    printf 'source bundle tree %s does not match declared tree %s\n' "$actual_tree" "$SOURCE_TREE" >&2
    return 2
  }
}
