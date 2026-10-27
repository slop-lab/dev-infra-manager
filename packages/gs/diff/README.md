# @slop-lab/gs-diff

Runtime-neutral Git unified diff parsing. No service, repository, authentication,
filesystem or DIM dependency. Works in Node and browsers with standard Web APIs.

```ts
import { parseGitDiff, lineAnchor } from '@slop-lab/gs-diff';
const snapshot = parseGitDiff(patch, { baseCommit, headCommit });
```

Both commit IDs must be complete SHA-1 or SHA-256 object IDs. Produce patches with
`git diff --no-ext-diff --no-textconv --no-color --full-index BASE HEAD --` using
Git's default `a/` and `b/` prefixes. Rename/copy headers, quoted UTF-8 paths,
empty files, binary markers and missing final newlines are represented. Combined
merge diffs, malformed hunks and truncated input are rejected. Limits default to
4 MB, 1,000 files and 100,000 patch lines, and are configurable positive integers.
The parser rejects the complete patch when a limit is exceeded; it never invents
partial success. Blob contents and executable diff drivers are not evaluated.

A line anchor records both immutable commit IDs, the path on the selected side,
the side and its line number. Store the full anchor for comments or blame. It
belongs to that snapshot, and consumers must explicitly show outdated revisions
instead of silently reusing its line in a later patch. Paths are display data;
consumers accessing repositories must perform their own repository authorization
and path handling. Non-UTF-8 filenames are rejected.
