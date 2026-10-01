self_project_publication_checks() {
  verification_stage="repository publication"
  if [[ "$self_project_single_tree" == true ]]; then
    publication_error="$state_root/publication.stderr"
    if dim repo publish "$project_name" >"$state_root/publication.stdout" 2>"$publication_error"; then
      echo "single-tree external publication unexpectedly succeeded without host Git sync authority" >&2
      return 1
    fi
    grep -Fq "repository synchronization requires DIM_GIT_SYNC_CONNECTION_FILE" "$publication_error"
    return 0
  fi
  dim repo publish "$project_name" >/dev/null
  for repository in root development core core-development plugin-dns-cloudflare plugin-dns-cloudflare-development plugin-external-urls plugin-external-urls-development verification examples specification; do
    managed_sha="$(git ls-remote "$(dim repo url "$project_name" "$repository")" refs/heads/main | cut -f1)"
    external_sha="$(git --git-dir="$source_root/remotes/archive.git" rev-parse "refs/heads/dev/$repository")"
    test -n "$managed_sha"
    test "$managed_sha" = "$external_sha"
  done
}

self_project_retained_volume_checks() {
  verification_stage="retained agent home across discard and recreation"
  if [[ ! -f "$ssh_host_fingerprint_file" ]]; then
    prepare_self_ssh_access
  fi
  prepare_workspace_user_setup
  retained_setup_state_before="$(workspace_user_setup_state)"
  retained_sentinel="retained-$PPID-$$-$(date +%s%N)"
  dim workspace run "$workspace_name" bash -- -lc \
    "printf '%s\\n' '$retained_sentinel' >\"\$HOME/dim-retained-discard-sentinel\""
  dim workspace discard "$workspace_name" --keep-volume --yes >/dev/null
  test ! -e "$state_root/workspaces/$workspace_name.json"
  test -z "$(docker ps -aq --filter "name=^/$container_name$")"
  docker volume inspect "$workspace_volume_name" >/dev/null
  dim workspace create "$project_name" "$workspace_name" >/dev/null
  workspace_json="$(dim workspace show "$workspace_name" --json)"
  container_name="$(jq -er .containerName <<<"$workspace_json")"
  workspace_volume_name="$(jq -er .dockerVolumeName <<<"$workspace_json")"
  test "$(jq -r .phase <<<"$workspace_json")" = ready
  test "$(workspace_user_setup_state)" = "$retained_setup_state_before"
  test "$(dim workspace run "$workspace_name" bash -- -lc \
    'cat /home/dim-agent/dim-retained-discard-sentinel')" = "$retained_sentinel"
  dim workspace run "$workspace_name" bash -- -lc 'pgrep -x sshd >/dev/null'
  record_self_ssh_host_key rotated
  assert_self_ssh_session
  verification_stage="ordinary workspace discard"
  dim workspace discard "$workspace_name" --yes >/dev/null
  if docker volume inspect "$workspace_volume_name" >/dev/null 2>&1; then
    echo "ordinary discard retained outer volume '$workspace_volume_name'" >&2
    return 1
  fi
  dim project purge "$project_name" --yes >/dev/null
}
