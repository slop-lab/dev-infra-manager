# @slop-lab/gs-ci

Standalone reviewed-candidate CI planning, required-job evidence and durable
event delivery. The package composes GS repository authority/read ports, GS
review preparation/storage and a typed execution provider. It has no DIM
scheduler, worker profile, credential, HTTP, activation or control-plane
registration dependency.

`createGitCiPreparation` reads candidate workflow bytes through an explicit
Git reader provider, captures exact repository snapshots through borrowed
repository authority and attaches the unchanged immutable plan. A workflow
provider has a validated name and SHA-256 revision. `createGitCiQualityGuard`
requires exact revision-bound execution evidence; missing, failed or stale
evidence denies promotion. The execution provider receives review/event/Git
identity only, never a VM/container profile or scheduler context.

`gitCiPolicyOwner` is authorization-enforced. A repository declaring `git-ci`
must select the `createGitCiRefUpdatePolicy` provider, whose revision binds the
execution provider. Protected-ref authorization resolves the current target
through the borrowed read authority and rechecks the exact candidate, policy,
plan and successful evidence before allowing the shared promotion path.

The durable outbox, intent catalog, marker recovery, capacity reservations,
projection attestations and plan storage moved here without changing their
paths, schemas or digest domains. `createCiDeliveryDispatcher` receives typed
repository enumeration and submit/receipt ports. It does not know HTTP,
credentials or a DIM coordinator endpoint.

Persisted `dim-git-ci-*` paths, event names and digest domains remain private
ABI. DIM keeps `.dim` compiler registration, execution grants/profiles,
scheduler placement, worker leases and source-credential transport as adapters.
