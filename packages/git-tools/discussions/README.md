# @slop-lab/git-discussions

Runtime-neutral revision-pinned Git discussion data. The package validates
general and line-anchored comments, appends comments to immutable lists, and
reports whether a comment belongs to an older revision.

```ts
import {
  appendDiscussionComment,
  commentIsOutdated,
  parseDiscussionComment,
} from "@slop-lab/git-discussions";

const comment = parseDiscussionComment(input);
const comments = appendDiscussionComment(existingComments, comment);
const outdated = commentIsOutdated(comment, currentRevisionId);
```

Anchors contain only a repository-relative path, base/head side, and positive
line number. An adapter must prove that the anchor is visible in the exact
immutable diff revision before storing it. This package has no pull-request
lifecycle, Git process, filesystem, service, authentication, HTTP, React, or DIM
dependency.
