#!/usr/bin/env bash

forge_require_commands() {
  local dependency
  for dependency in curl git jq; do
    command -v "$dependency" >/dev/null || {
      echo "pull-request: missing dependency: $dependency" >&2
      return 1
    }
  done
}

forge_resolve() {
  local remote="${1:-origin}" remote_host path
  forge_require_commands
  forge_remote="$remote"
  forge_remote_url="$(git remote get-url "$remote" 2>/dev/null)" || {
    echo "pull-request: Git remote '$remote' does not exist" >&2
    return 1
  }

  case "$forge_remote_url" in
    http://*|https://*)
      forge_url="$(printf '%s\n' "$forge_remote_url" | sed -E 's#^(https?://[^/]+).*$#\1#')"
      path="${forge_remote_url#"$forge_url"/}"
      ;;
    ssh://*)
      remote_host="$(printf '%s\n' "$forge_remote_url" | sed -E 's#^ssh://([^@/]+@)?([^/:]+).*$#\2#')"
      forge_url="${PR_FORGE_URL:-https://$remote_host}"
      path="$(printf '%s\n' "$forge_remote_url" | sed -E 's#^ssh://([^@/]+@)?[^/]+/##')"
      ;;
    *@*:*)
      remote_host="$(printf '%s\n' "$forge_remote_url" | sed -E 's#^([^@]+@)?([^:]+):.*$#\2#')"
      forge_url="${PR_FORGE_URL:-https://$remote_host}"
      path="${forge_remote_url#*:}"
      ;;
    *)
      echo "pull-request: remote '$remote' is not an HTTP(S) or SSH forge URL: $forge_remote_url" >&2
      return 1
      ;;
  esac

  forge_url="${PR_FORGE_URL:-$forge_url}"
  forge_url="${forge_url%/}"
  path="${path%.git}"
  path="${path#/}"
  forge_repository="$(printf '%s\n' "$path" | awk -F/ 'NF >= 2 { print $(NF-1) "/" $NF }')"
  [[ "$forge_repository" == */* ]] || {
    echo "pull-request: cannot derive owner/repository from remote '$forge_remote_url'" >&2
    return 1
  }
  forge_owner="${forge_repository%/*}"
  forge_repo="${forge_repository#*/}"
  forge_host="$(printf '%s\n' "$forge_url" | sed -E 's#^https?://([^/]+).*$#\1#')"

  forge_provider=unknown
  if [[ "$forge_host" == github.com || "$forge_host" == api.github.com ]]; then
    forge_provider=github
  elif curl --fail --silent --show-error --max-time 5 "$forge_url/api/v1/version" 2>/dev/null |
    jq -e '.version | type == "string"' >/dev/null 2>&1; then
    forge_provider=gitea
  fi
}

forge_print_identity() {
  jq -n --arg provider "$forge_provider" --arg remote "$forge_remote" \
    --arg remoteUrl "$forge_remote_url" --arg forgeUrl "$forge_url" \
    --arg repository "$forge_repository" \
    '{provider:$provider,remote:$remote,remoteUrl:$remoteUrl,forgeUrl:$forgeUrl,repository:$repository}'
}

gitea_configure_api() {
  [[ "$forge_provider" == gitea ]] || {
    echo "pull-request: Gitea operation requested; detected '$forge_provider' at $forge_url" >&2
    return 3
  }

  gitea_credential_args=()
  if [[ -n "${GITEA_TOKEN:-}" ]]; then
    gitea_credential_args=(--header "Authorization: token $GITEA_TOKEN")
    return
  fi

  local protocol credential_host credential username password
  protocol="${forge_url%%://*}"
  credential_host="${forge_url#*://}"
  credential_host="${credential_host%%/*}"
  credential="$(printf 'protocol=%s\nhost=%s\n\n' "$protocol" "$credential_host" | git credential fill)" || {
    echo "pull-request: no Git credential is available for $credential_host" >&2
    return 1
  }
  username="$(printf '%s\n' "$credential" | sed -n 's/^username=//p')"
  password="$(printf '%s\n' "$credential" | sed -n 's/^password=//p')"
  [[ -n "$username" && -n "$password" ]] || {
    echo "pull-request: incomplete Git credential for $credential_host" >&2
    return 1
  }
  gitea_credential_args=(--user "$username:$password")
}

gitea_api() {
  local method="$1" endpoint="$2"
  shift 2
  curl --fail --silent --show-error "${gitea_credential_args[@]}" \
    --request "$method" --header 'Content-Type: application/json' \
    "$@" "$forge_url/api/v1$endpoint"
}
