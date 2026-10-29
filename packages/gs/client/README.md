# @slop-lab/gs-client

Portable Git review, pull request, immutable diff, blame, CI view and sync
client logic over an injected bounded JSON transport. Public repository scope
uses `{ namespaceId, repositoryId }`. Every external response is parsed into a
bounded GS model before it is returned.

The package has no DIM source, configuration, credential, identity attestation,
Project, operation-presentation, HTTP, filesystem or scheduler dependency.
Embeddings select capabilities independently and implement `BoundedJsonTransport`.
The transport receives semantic request variants plus a response byte limit;
an HTTP adapter is responsible for paths, authentication, deadlines and
enforcing that limit before parsing JSON.

Pull request decisions remain bound to the selected record version and immutable
revision. Merge never creates an approval, requires existing review and CI
success, promotes the exact reviewed revision, and reports a pending PR refresh
without discarding an accepted promotion receipt.
