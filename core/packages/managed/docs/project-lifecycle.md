# Native Project and workspace lifecycle

A Project identifies one native root repository, protected ref, imported
commit/tree and versioned review policy. Bootstrap stages reviewed input;
admission and readiness prove the service generation, snapshot and proposal
transport. Ready does not imply CI results, human approval or promotion.
Project files, connections and pending/ready records belong to the optional
managed integration.

A workspace is a core UUID with persistent home, checkout and Docker storage.
For `dim://PROJECT`, managed source acquisition obtains the ready protected
snapshot and a separate native attachment. There is one core lifecycle and no
managed workspace state format or independent outer runtime.

The workspace can read its selected Project and create or fast-forward its own
proposal refs. Direct protected updates, deletion, forced updates, tags and
another workspace's proposal namespace are denied by native Git. Operator
credentials stay on the host; the checkout receives a scoped broker grant.
Human review and checked protected-ref compare-and-swap remain service-side.

The broker checks current core identity and phase for each request. Stopped or
uninitialized workspaces cannot use Git transport; discard and name reuse
invalidate the old attachment. Start/recreate preserve mutable user data.
Verified protected fast-forwards keep the existing scoped Git capability
usable. They do not reset local files. Review-policy changes fail closed.
