prepare_self_project_workspace() {
  if [[ -d "$project_source/project/.git" ]]; then
    mkdir -p "$source_root/repositories"
    for repository in development root core core-development \
      plugin-dns-cloudflare plugin-dns-cloudflare-development \
      plugin-external-urls plugin-external-urls-development verification examples specification; do
      case "$repository" in
        development) repository_source="$project_source" ;;
        root) repository_source="$project_source/project" ;;
        *) repository_source="$project_source/$repository" ;;
      esac
      dim_prepare_clone_source "$repository_source" "$source_root/snapshot-$repository"
      mkdir -p "$source_root/repositories/$repository"
      git -C "$DIM_GIT_CLONE_SOURCE" archive HEAD | tar -x -C "$source_root/repositories/$repository"
    done
  elif [[ -d "$project_source/.git" && -d "$project_source/core" && -d "$project_source/verification" ]]; then
    self_project_single_tree=true
    mkdir -p "$source_root/repositories/root"
    dim_prepare_clone_source "$project_source" "$source_root/snapshot-root"
    git -C "$DIM_GIT_CLONE_SOURCE" archive HEAD | tar -x -C "$source_root/repositories/root"
  else
    echo "assembled split or single-tree DIM repository set is required for self-Project verification" >&2
    return 2
  fi
  project_source="$source_root/repositories/root"
  dim_apply_test_registry_mirror "$project_source" agent-dind
  mkdir -p "$source_root/remotes"
  git init --bare "$source_root/remotes/archive.git" >/dev/null
  (
    cd -- "$integrated_source/verification"
    node --input-type=module - "$project_source/.dim/repos.yml" "$source_root/remotes/archive.git" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
const [manifestPath, archive] = process.argv.slice(2);
const manifest = parse(readFileSync(manifestPath, "utf8"));
for (const [repository, config] of Object.entries(manifest.repositories)) {
  const upstream = config.upstream;
  manifest.upstreams[upstream].url = archive;
  config.import = { main: `dev/${repository}` };
}
writeFileSync(manifestPath, stringify(manifest));
EOF
  )
  for repository_path in "$source_root"/repositories/*; do
    repository="$(basename "$repository_path")"
    git -C "$repository_path" init --initial-branch="dev/$repository" >/dev/null
    git -C "$repository_path" add -A
    git -C "$repository_path" \
      -c user.name="DIM Snapshot" \
      -c user.email="snapshot@dim.invalid" \
      commit -m "initialize $repository smoke source" >/dev/null
    git -C "$repository_path" push "$source_root/remotes/archive.git" \
      "HEAD:refs/heads/dev/$repository" >/dev/null
  done
  root_ref=dev/root
  dim project create "$project_name" \
    --bootstrap-git-url "$source_root/remotes/archive.git" \
    --bootstrap-git-ref "$root_ref" >/dev/null
  verification_stage="workspace creation"
  if ! dim workspace create "$project_name" "$workspace_name" \
    > >(tee "$workspace_creation_log") 2>&1; then
    dim workspace exec "$workspace_name" -- \
      docker compose --project-name "dim-project" --file .dim/docker-compose.yml ps >&2 || true
    dim workspace exec "$workspace_name" -- \
      docker compose --project-name "dim-project" --file .dim/docker-compose.yml logs --no-color >&2 || true
    return 1
  fi
  workspace_json="$(dim workspace show "$workspace_name" --json)"
  container_name="$(jq -er .containerName <<<"$workspace_json")"
  workspace_volume_name="$(jq -er .dockerVolumeName <<<"$workspace_json")"
  test "$(jq -r .phase <<<"$workspace_json")" = ready
}

self_project_workspace_phase() {
  verification_stage="workspace runtime manifest"
  dim workspace exec "$workspace_name" -- jq -e '
    .schemaVersion == 3 and
    .project.name == "dim-self-smoke" and
    .root.repository == "root" and
    .root.ref == "refs/heads/main" and
    .root.path == "/run/dim/project-root" and
    .data.path == "/var/lib/dim/workspace-data"
  ' /run/dim/project.json >/dev/null
  verification_stage="workspace registry mirror"
  dim workspace exec "$workspace_name" -- \
    docker info --format '{{json .RegistryConfig.Mirrors}}' |
    grep -Fq 'http://dim-registry-cache:5000/'
  verification_stage="workspace Docker config ownership"
  dim workspace exec "$workspace_name" -- sh -eu -c '
    test ! -e "$HOME/.docker" || test "$(stat -c %u "$HOME/.docker")" = "$(id -u)"
  '
  self_project_workspace_checks
}
