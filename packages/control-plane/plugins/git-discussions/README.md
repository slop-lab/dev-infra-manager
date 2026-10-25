# Git discussions control-plane plugin

Adds revision-pinned discussions to the Git pull request service without adding
conversation handling to Git review or the diff renderer. Requires repository
access, Git pull requests, and Git diff services.
Portable comment and anchor schemas come from `@slop-lab/git-discussions`.

`POST /v1/projects/:project/repositories/:repository/pull-requests/:id/comments`
accepts `{expectedVersion,revisionId,body,anchor?:{path,side,line}}`, where `side`
is `base` or `head`. The server derives the actor from the existing trusted
repository identity. General comments may omit an anchor. Anchored comments must
identify a visible text line in that exact immutable revision; invalid lines,
wrong-side paths and binary anchors are rejected. The server never relocates a
comment after a new push.

PR record versioning serializes edits, pushes and comment changes. A stale form
must refresh before retrying. Discussion access grants no review approval or
promotion authority. The React display uses the portable PR model and derives
outdated status from revision IDs.
