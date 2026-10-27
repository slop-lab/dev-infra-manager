# Git diff control-plane plugin

An optional read-only repository extension. `POST /v1/projects/:projectId/repositories/:repositoryId/diff`
accepts `{baseCommit, headCommit}` with complete immutable commit IDs and returns an
`@slop-lab/gs-diff` snapshot. The portable model and React renderer have no DIM dependency.

The repository access provider authenticates the caller, checks generation, current
activation and project/repository policy membership. The same checks run before and
after reading objects. Both commits must be reachable from managed protected branches
or workspace proposal branches in that exact registered repository. Integrations may
advertise their own durable revision pins through the repository read-history
extension, so a PR revision remains inspectable after a proposal force push. Arbitrary refs,
revision expressions, paths and Git options are never accepted.

Diffs use actual committed bytes with external diff, text conversion, replacement
objects and hooks disabled. Renames, binary changes and absent final newlines are
represented explicitly. Non-UTF-8 text, oversized blobs, excessive files/lines or
responses fail as a whole; results are never silently truncated. Blob metadata
records exact content identity, byte length and text line count for both file sides.

`dim.git-diff.service` exposes immutable snapshot reads to trusted repository
extensions. Callers must authorize the actor and hold the repository serialization
queue. `validateDiffAnchor` accepts only text lines visible in the exact snapshot;
a later revision cannot silently relocate an old comment.
