# Git pull requests

A portable TypeScript model for pull request revisions and lifecycle transitions.
Discussion schemas and list primitives come from `@slop-lab/git-discussions`. It has no
DIM, HTTP, Git process, filesystem, authentication, or React dependency. Adapters
supply identity, exact commit IDs, IDs, timestamps, storage and authority checks.

A pull request keeps its ID across pushes. Each pair of source and target commits
has an immutable revision ID. Stored comments retain that ID and record layout.
Pure transition functions require
an expected record version and reject stale writes. They never grant approval or
write repository refs. `markMerged` requires an adapter's prior merge proof.

PR, revision and comment IDs are opaque strings. An adapter may use an external
service number or its own IDs; UUIDs and DIM proposal namespaces are not required.
DIM-specific adapters validate their own storage IDs and access rules separately.
