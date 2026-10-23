# Git blame control-plane plugin

This optional repository extension adds `POST /v1/projects/:projectId/repositories/:repositoryId/blame`.
The body `{commit,path,line}` selects an exact committed text line. The response
`{commit,path,line,author,summary}` identifies its originating commit. No email or
server filesystem path is returned. This operation does not approve or promote changes.

The configured repository access provider proves identity, generation, live
activation and repository membership before and after the bounded read. The commit
must be reachable from a managed protected branch, a workspace proposal, or a durable
revision pin advertised by a trusted repository integration. Paths
select immutable tree entries; no checkout, hook, external diff or text conversion runs.

This package has no dependency on the PR, diff rendering, or review domain. UI
extensions can display attribution on a selected diff line without adding blame
logic to the shared diff component.
