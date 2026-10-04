# Native ordinary CI control plane

This is the unimplemented target implementation and operator design for the ordinary CI
scheduler/webhook service installed with native Git. The normative authority,
admission, and installer transaction are in
`specification/specs/10-cli-contract.md` and
`specification/specs/14-installer-facade.md`.

This design is not implemented at the documentation revision that introduced
it. The shipped Gitea predecessor still provides `dim ci ordinary-pool service
run CONFIG` and `dim ci ordinary-pool project reconcile PROJECT
REGISTRAR_CONFIG`; its standalone `worker` commands have been removed in favor
of managed-controller supervision. Those commands, schema-2 databases, and
persistent Project-scoped Sysbox runners are not the native target and are
rejected only after that target replaces the predecessor. Do not deploy this
topology or claim its acceptance gates until the service and host controller
implementation pass the referenced verification.

## Ownership matrix

| Concern | Owner | Explicitly not owner |
| --- | --- | --- |
| Compose deployment, image digests, fixed mounts, ports, readiness, rollback | installer facade | operational CLI |
| Bare repositories, proposal transport, review and exact CI evidence, protected promotion | native Git service | ordinary scheduler, host controller |
| Project admission, webhook demand, attempts, queue, claim leases | ordinary CI service | native Git storage, host runtime |
| Shared capacity, Sysbox execution, cleanup, result submission | each DIM host controller | Compose services, Project lifecycle |
| Ordinary image and labels | immutable Project admission for one disposable job | persistent runner/image state |
| QEMU integration demand and execution | optional QEMU scheduler and host QEMU supervisors | ordinary CI service |

Neither control-plane service receives a host Docker socket, controller socket,
`/dev/kvm`, or generic remote-execution capability. A scheduler lease is
permission for one authenticated host controller to attempt one admitted job;
it is not a runtime control channel.

## Service-private state

The Compose project is exactly `dim-control-plane`. The `native-git` service
runs as `10001:10001`, mounts only
`dim-control-plane-native-git-data:/var/lib/dim-native-git`, and listens on
container port `8080`. The `ordinary-ci` service runs as `10002:10002`, mounts
only `dim-control-plane-ordinary-ci-data:/var/lib/dim-ordinary-ci`, and also
listens on its own container port `8080`. Compose publishes each to the distinct
host address and port in the installer config. The only shared resource is the
fixed `dim-control-plane` bridge network.

The native volume contains bare repositories and immutable review, attempt,
result, and promotion evidence. The ordinary volume contains
`ordinary-ci.sqlite3` plus SQLite-owned `-wal` and `-shm` files. It contains no
repository bytes, image layer, runner work directory, registration data, or
Project checkout. This contract grants the installer no backup, export, restore,
or data-conversion authority over either volume.

Compose resources carry these exact labels in addition to Compose's own labels:

```text
org.dim.managed=true
org.dim.bundle=control-plane
org.dim.deployment=<deploymentId>
org.dim.resource=network|volume|service
org.dim.service=native-git|ordinary-ci
```

The network omits `org.dim.service`. A service volume and container include the
matching service value. Missing, malformed, partial, foreign, or mismatched
labels are conflicts. Installation, update, rollback, and removal act only on
the immutable container ID or exact volume/network name returned by a
successful complete-label inspection. The installer never adopts, relabels, or
deletes a conflict.

## Private service configuration

The operator supplies DIM-user-owned mode-`0600` service JSON and readiness
token source files. The installer descriptor-validates and copies them into one
immutable generation directory, then mounts the mode-`0444` snapshots at
`/run/secrets/service.json` and `/run/secrets/readiness.token`. It separately
generates and snapshots one service-specific activation token at
`/run/secrets/activation.token`. Mutable operator paths are never mounted. The
mode-`0700` DIM-owned generation directory prevents host traversal while the
individual bind mounts remain readable by the fixed service UID. The generated
Compose file contains snapshot paths but no secret bytes.

The ordinary service JSON is strict schema `3`:

```json
{
  "schemaVersion": 3,
  "serviceId": "ordinary-main",
  "listen": { "host": "0.0.0.0", "port": 8080 },
  "database": "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3",
  "nativeGit": {
    "endpoint": "http://native-git:8080",
    "serviceId": "native-main",
    "query": {
      "username": "native-main",
      "password": "replace-with-query-only-dependency-credential"
    },
    "identity": {
      "username": "ordinary-identity",
      "password": "replace-with-identity-credential"
    },
    "attemptIssuer": {
      "username": "ordinary-attempts",
      "password": "replace-with-attempt-issuer-credential"
    },
    "resultReporter": {
      "username": "ordinary-results",
      "password": "replace-with-result-reporter-credential"
    }
  },
  "leaseSeconds": 60,
  "admissionLeaseSeconds": 300,
  "hosts": {
    "host-a": {
      "hostToken": "replace-with-host-token",
      "admissionToken": "replace-with-admission-token",
      "resultToken": "replace-with-result-token",
      "capacities": ["primary"]
    }
  }
}
```

`listen` and `database` must equal the fixed deployment values. The native Git
endpoint is exactly the Compose-network origin above and follows no redirect.
Ordinary `/readyz` validates only its immutable config snapshot, local database
readability and durability, and local listener; it neither contacts native Git
nor requires Project state. Every token and native-facing password is distinct,
base64url, and at least 32 random bytes.
The host map contains installation capacity identities only; it contains no
Project, repository, image, label, or Git credential. Adding or removing a host
is a reviewed operator-source update that creates a new immutable bundle
generation, not a service API.

The native Git service config remains strict schema `1` as specified by the
native Git transport profile. For this deployment its listener and storage root
must be `0.0.0.0:8080` and `/var/lib/dim-native-git`; it must name the exact
ordinary service origin `http://ordinary-ci:8080`, service identity, and a
distinct query-only service-to-service dependency credential. Its Git
transport, reviewer, administrator, and promoter credentials do not appear in
the ordinary config. The installer invokes each image's `dim-service
check-config` before mutation, so cross-service identity, fixed path, token
distinctness, and schema failures are preflight failures.

The native query credential may read only the exact current admission and
attempt status needed by native promotion checks. The ordinary identity
credential may verify only exact configured native service and repository
identities. The attempt-issuer credential may issue or revoke only a current
attempt for an exact live ordinary admission tuple and required job; it cannot
report a result. The result-reporter credential may report only the terminal
result for that exact current attempt and job; it cannot issue or revoke.
Neither credential can read Git, approve, promote, administer storage,
enumerate unrelated Projects, or act before the native identity check for that
operation succeeds.

## Admission and execution flow after a Project adapter

This flow is constrained but unavailable. Bundle installation leaves both
services empty and idle. Until a separate native Project/repository state
adapter is specified and implemented, admission, native webhook demand,
capacity advertisement, claim, and result operations fail before mutation.

1. A trusted host controller resolves the protected native root ref once and
   reads `.dim/ci/runner.yml`, policy revision, job-set revision, commit, and
   tree from that immutable selection.
2. Using only its admission credential, it submits the normalized ordinary
   policy. The service verifies native Git identity for that operation with its
   identity credential and verifies the immutable tuple before publishing or
   refreshing one leased admission generation.
3. Native Git sends an authenticated candidate/job webhook. The ordinary
   service re-verifies native identity, accepts the event only against that
   exact live generation, and uses only its attempt-issuer credential to
   durably issue the current native attempt before acknowledging demand.
4. A host controller claims through its host credential for one configured
   capacity. The claim contains the immutable execution tuple and no reusable
   authority.
5. The controller ownership-checks its local capacity, force-pulls the admitted
   digest, probes declared tools, launches one bounded ephemeral Sysbox runner,
   renews the lease, and submits terminal evidence with its result credential.
6. The ordinary service authenticates the controller result and uses only its
   result-reporter credential to submit the exact terminal attempt result to
   native Git. The controller stops and removes its owned runtime and temporary
   credentials before releasing capacity.

An unavailable native service, invalid protected tuple, missing admission,
wrong service or host identity, unknown capacity, expired generation, changed
image, failed tool probe, uncertain lease, or failed result submission fails
closed. No condition falls back to a persistent runner, local scheduler, direct
protected write, or unpinned image.

## Updates and recovery

The facade updates `ordinary-ci` first and `native-git` second. Each image is
digest-pinned and each replacement must pass authenticated `/readyz`; ordinary
readiness is local-only, while native readiness additionally proves the exact
ordinary dependency. Candidates reject mutating operations until the installer
publishes and activates their exact immutable generation. The prior Compose
bytes, image digests, and input snapshots remain available through rollback.
Rollback restores those inputs and images in the same order but never rolls
back a data volume.

Before replacement, candidate and prior images must report the same current
state format. For each service, the current persisted state format must be in
both images' `readableFormats`, the candidate `writeFormat` must be in the prior
image's `readableFormats`, and the prior `writeFormat` must be in the candidate
image's `readableFormats`. Missing, disagreeing, one-way, or non-overlapping
compatibility metadata rejects the update before mutation. These three checks
permit both forward startup and rollback after activation without copying or
reverting data.

Schema-less, schema-1, and predecessor schema-2 ordinary databases are rejected
before opening WAL or writing bytes. A missing established volume, changed
deployment ID, service UID, mount path, volume name, or container port is an
operator incident. There is no migration, volume copy, dual-write, or adoption
path. Use the old pinned release to stop legacy services and remove
Project-scoped Sysbox capacity before a fresh schema-3 deployment. No export or
conversion procedure is defined here.

After the separate Project adapter exists, an expired claim fences only that
host capacity. On restart, the host controller inspects and reaps the exact
locally owned container before acknowledging recovery; a foreign same-name
resource remains untouched and keeps the capacity fenced. Other hosts continue.
Restarting either control-plane service preserves admission generations, queued
demand, attempts, claims, and terminal evidence, but never converts an old
generation to current.

## Operator acceptance

Acceptance requires the control-plane bundle gate in
`specification/specs/12-verification.md`. The previous
`just verify ordinary-ci-pool-live` Gitea fixture is predecessor evidence only;
it is not acceptance for this native schema-3 topology. The replacement gate
must exercise bundle isolation, local ordinary readiness, native dependency
readiness, credential-role denials, immutable input snapshots, compatibility
refusal, and update rollback. Successful Project admission, two-host execution,
and real Sysbox job evidence remain blocked on the missing native Project
adapter and MUST NOT be claimed by this installer-only gate. QEMU scheduler
checks remain separate Gitea-only predecessor evidence.
