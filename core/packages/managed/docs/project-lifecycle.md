> Scope: optional managed integration. This document describes the previous managed
> architecture and is scoped to that integration, not base workspace behavior.
> The base workspace contract is in `specification/specs/`.

# Native root and workspace lifecycle

**Kind: Contract**

**PROJECT-NATIVE-ROOT-001:** A Project is one stable native ID, one root
repository ID, one protected branch ref, one exact imported commit/tree, and
one versioned review policy. Bootstrap stages immutable reviewed input. Create
publishes pending state, obtains fresh proof, validates the protected snapshot
and proposal-only transport, then atomically publishes schema-6 ready state.

Ready does not imply deployed CI, a CI result, human approval, or promotion.
List/show are bounded local queries. Exact replay converges without timestamp
or identity churn.

**WORKSPACE-NATIVE-001:** A workspace requires a ready Project and stores strict
schema-9 `source.kind: "native"` state. It receives an immutable protected-root
snapshot and a scoped broker grant. The broker mints short-lived credentials
only for exact Git smart-HTTP operations and never returns them to the client.

The workspace writer may create or fast-forward its own proposal refs. Direct
protected updates, protected deletion, force, tags, another workspace's
namespace, or another Project fail without ref mutation. Setup may replay the
recorded immutable snapshot without fresh proof. Start, restart, and update
obtain fresh proof while preserving mutable checkout data.

**STATE-NATIVE-CUTOVER-001:** Historical provider-backed Project/workspace
records and runner records are rejection-only fixtures. Native lifecycle does
not read them as current state, migrate them, adopt their resources, or delete
them. Operators export data with the pinned prior release and create fresh
native identities.
