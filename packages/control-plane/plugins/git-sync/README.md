# Managed Git upstream synchronization

`@slop-lab/dim-control-plane-plugin-git-sync` attaches explicit external Git
operations to the repository service. It validates the `git-sync` repository
policy namespace, authenticates selected operators, fetches a reviewed upstream,
creates clean merge proposals and publishes authoritative protected commits
without force. It never writes protected refs directly.

Install it with the standalone control-plane runtime and repository plugin; no
host core or workspace package is required. Add code-review and merge-policy
for the proposal review/promotion path. The Native Git host plugin owns the
operator commands and `.dim/repos.yml` declaration compilation. Remote provider
credentials remain private service configuration.

See the [Git synchronization guide](../../../../docs/guides/git-sync.md) for
configuration, branch mapping and commands. Tests live in
`tests/control-plane/plugins/git-sync` and use disposable Git repositories.
