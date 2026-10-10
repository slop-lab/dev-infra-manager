# Verification

For a single-tree Project with trusted lifecycle code and agent-changeable
sources, verification MUST exercise the actual Git-host protected-ref policy:
ordinary writers and repository owners cannot directly update `main`, including
renames, deletions, and changes outside `.dim`; proposal branches remain
writable; and reviewed pull requests require a current designated human
approval before merge. The host-only maintainer remains an explicit trusted
exception, and force pushes remain disabled. Project-specific CI MUST report
the exact candidate commit and complete tree used to test whether `.dim` and
its dependencies are safe; a successful test is review evidence, not a
replacement for Git-host authorization.

Origin-rebind verification MUST include a real disposable Git history where
the new exact external tip descends from the managed protected-root tip while
the managed ref remains unchanged. It MUST reject an unrelated history, stale
old-origin digest, moved managed or external tip, changed ref mapping or
protection policy, unsafe URL, and missing explicit approval. The default
`repo apply --file` origin conflict MUST remain a refusal. A monorepo Project
gate MUST run against the exact complete candidate tree, record its commit,
tree, imported source SHAs and overlay digest, and report unavailable QEMU
capacity as unavailable rather than a pass.

A split-Project QEMU gate MUST snapshot the development root without adding
its separately owned Project root or sibling repositories to the development
Git tree. It MUST keep each child independently materialized as a Git
repository after snapshot transfer; a parent checkout containing plain child
directories is not a valid verification fixture.

A single-tree candidate MUST replace split-repository CI workflows with
candidate-only, reviewed workflow bytes recorded in the overlay digest. The
ordinary source job MUST check out one exact candidate SHA, verify its full
tree and the imported source ancestry, source trees, GitHub history, and
overlay bytes, then run the complete source gate. The manually dispatched
release gate MUST require a full lowercase candidate SHA matching the
selected dispatch ref; its container-integration and disposable-QEMU Sysbox
jobs MUST independently check out and verify that same SHA without persisting
checkout credentials. Each lane reports its own result and immutable
evidence. A source pass or unavailable QEMU capacity MUST NOT count as a full
release pass, and CI evidence MUST NOT grant protected-ref publication or
host deployment authority.

## Trust and lifecycle contract gates

Verification of
[Trust and Lifecycle Capability Matrix](04-trust-lifecycle-capability-matrix.md)
MUST distinguish contract evidence from unavailable runtime capability.

For `TRUST-PROMOTION-001` and `TRUST-PROMOTION-CAS-001`, deterministic tests
MUST bind review and every required job to one repository, protected ref,
expected head, candidate commit and tree, policy revision, review revision, and
job-set revision. They MUST enumerate additions, modifications, deletions,
renames, modes, and symbolic links in the complete change set. Tests MUST
reject path-only approval, self or workload approval, stale or revoked
approval, missing, unknown, future, late, revoked, or wrong-attempt jobs, changed policy/tree/head, non-descendant
candidates, protected deletion, and force push. A concurrent promotion test
MUST prove that exactly one compare-and-swap succeeds and every loser leaves
the winning ref unchanged. Live Git-host evidence MUST exercise the actual
protected policy and atomic old-object-ID update; a mock alone is insufficient.

The native Git gate covers this contract through a real bare repository and
Git CLI. It MUST expose the complete
base-to-candidate diff through the reviewer API and CLI, persist immutable
approval and revocation across restart, invalidate changed refs, trees, policy,
or bound identities, and deny writer/read-only/administrator/foreign approval.
The host API MUST additionally persist authenticated exact per-job terminal
evidence, require a durable scheduler-issued current attempt identity, and
reject nonterminal, foreign, tuple-mismatched, conflicting, missing, unknown,
future, late, revoked, and superseded-success input. With every
required current approval and successful job present, one Git ref transaction
MUST verify the proposal ref and compare-and-swap the protected old object ID
to the candidate. Tests MUST prove restart persistence, exact-candidate
idempotence, one concurrent winner, cross-process single-owner enforcement,
role separation, and unchanged protected
refs for every denial. Smart HTTP MUST remain proposal-only.

Native ordinary-CI tests MUST label their result
`candidate-controlled`, not independent. They MUST prove that one exact
candidate tree supplies schema-3 `.dim/ci/runner.yml` and the regular script
blob; that the strict parser rejects schemas 1 and 2, unknown/duplicate YAML fields,
aliases/tags, oversized or non-UTF-8 input, unsafe paths, symlinks, gitlinks,
any candidate image field, extra or missing required jobs, and any argv other than
the fixed Bash vector; and that webhook fields cannot select an image, command,
script, environment, mount, network, URL, resource, or credential. A successful
fixture MUST observe that the selected candidate-controlled tests execute in
the bounded sandbox and exit zero. Reviewer output MUST distinguish that result
from an independently selected check and MUST NOT present it as proof that the
tests are correct or complete.

The gate MUST also demonstrate the product/QA interpretation presented to a
reviewer: green means the selected candidate-controlled tests ran and exited
successfully under the recorded descriptor, not that their definitions were
correct or complete and not that the product is regression-free. Promotion
evidence MUST retain the reviewed test definition and result provenance so
product maintainers can assess changed requirements, implementation, tests, and
results. This product review is distinct from infrastructure security review of
secret exposure, protected-ref authority, host/runtime privilege, and trusted
capability elevation.

## Control-plane bundle gate

For `INSTALLER-CONTROL-PLANE-001`,
`INSTALLER-CONTROL-PLANE-ADMISSION-001`, and
`INSTALLER-CONTROL-PLANE-TRANSACTION-001`, one disposable clean-host gate MUST
invoke the packaged facade as:

```bash
dim installer install control-plane --config FILE
```

The gate MUST use two built digest-pinned images and the exact schema-1
installer config after implementation exists. It MUST inspect the effective
Compose model and running containers, not only source templates, and prove:

1. the project contains exactly `native-git` and `ordinary-ci`, the fixed
   network and two fixed volumes, distinct `10001:10001` and `10002:10002`
   identities, fixed internal listeners, exact configured host publications,
   read-only root filesystems, dropped capabilities, `no-new-privileges`,
   DIM-user-owned mode-`0600` operator sources, immutable mode-`0444`
   generation snapshots below a mode-`0700` directory, and service-private
   mounts that name snapshots rather than operator paths;
2. neither container has a host Docker/containerd/controller/workspace/admin
   socket, `/dev/kvm`, host device, host namespace, privileged mode, another
   service's volume, or secret bytes in its environment or rendered Compose;
3. both built images' fixed `/usr/local/bin/dim-service ready` commands run as
   their service UIDs, read only the mounted readiness token, and fail bounded
   for unauthenticated, wrong-token, redirecting, malformed, overlong,
   wrong-service, absent-server, and dripping responses; ordinary readiness
   succeeds from local durable state while native Git is stopped, native
   readiness fails without ordinary identity, and then succeeds with the exact
   ordinary service;
4. installation creates no Project, repository, runner, image copy, capacity,
   webhook, or browser UI and publishes no undeclared port; and
5. installer readiness succeeds through exact owned-container IDs when the
   installer namespace cannot connect to the daemon host's published service
   ports, Docker argv contains no readiness token, and no third container joins
   the private network; and
6. changing a mutable operator source after snapshot creation does not alter
   either running service, and rerunning identical input is byte- and
   identity-stable and does not recreate containers or volumes. A publish-only
   change must instead run the complete checked update and publish a new
   generation without changing either volume identity.

Pre-mutation denial cases MUST include a symlink, wrong owner or mode, unknown
field, schema mismatch, mutable/tagged image, digest mismatch, duplicate or
wildcard port, occupied port, foreign/partial resource labels, missing
established volume, changed deployment identity, invalid service config,
cross-service credential mismatch, duplicate credential, and
absence of Compose v2. The occupied-port case MUST use a uniquely named
daemon-published blocker, not a host-process listener, and observe refusal
before `network create`, `volume create`, or Compose `up`. It MUST also prove a
free candidate passes, exact current-owned tuples are not spuriously rejected,
and a publish-only update probes only changed tuples before replacing either
service. Each case MUST leave control-plane containers, networks,
volumes, installed Compose bytes, private files, and running service IDs
byte-for-byte or identity-equivalent unchanged. A digest pulled for image
config validation may remain only in the image cache and must be reported.
Disposable publication probes MUST carry no state volume, socket, config mount,
token, source secret, or bundle/Compose ownership label and MUST leave no
container after either success or refusal.
`dim install-cp` MUST exit `2`, identify the supported facade command, and make
no Docker or state call. In the shipped Gitea predecessor, `dim ci
ordinary-pool service run` and `dim ci ordinary-pool project reconcile` remain
available while `dim ci ordinary-pool worker ...` is rejected. Once the target
native bundle replaces that predecessor, its acceptance gate MUST prove that
all three obsolete ordinary-pool command families exit `2` without Docker or
state calls.

Update evidence MUST inject a unique version marker into each digest-pinned
test image and observe ordinary local readiness before native replacement.
Native readiness MUST remain false until it verifies the new ordinary service
identity. Candidate and prior compatibility and read-only state probes MUST
agree on the current format. For each service they MUST prove all three checks:
the current persisted state format is readable by both images, the candidate
`writeFormat` is in the prior image's `readableFormats`, and the prior
`writeFormat` is in the candidate image's `readableFormats`. Missing, malformed,
disagreeing, one-way, or non-overlapping metadata MUST refuse without resource
mutation. Both candidates MUST reject every mutating request before
exact-generation publication and activation.
Success atomically publishes the new Compose bytes, complete input snapshot
digests, and generation ID before activation, and removes obsolete exact-owned
containers without changing volume identity.

Rollback evidence MUST inject failures at ordinary startup, ordinary
readiness, native startup, native dependency readiness, and installed-state
publication. In every case it MUST stop only complete-label-matching
replacement container IDs, restore exact prior image digests and Compose bytes,
restore the exact prior generation and all of its config, readiness, and
activation snapshots, start ordinary before native, and observe both prior
authenticated readiness responses through exact-ID service-local execs before
reactivating that generation. Candidate publish endpoints MUST not be used for
installer readiness after prior Compose restoration. Repository, evidence,
queue, attempt, claim, and admission sentinels in both volumes MUST survive
without volume copying or byte rollback. A failed first installation retains
created volumes but removes exact-owned containers/network and reports those volumes.
A replacement-shutdown failure and a prior-readiness failure MUST each halt
automatic rollback, preserve both Compose files, both generations' input
snapshots, and all volumes, report the original plus rollback error, and never
report success.

The installed native-Git image gate MUST import one protected root under
generation A, restart on the same volume under B, deny proof and read leases
before B activation, then return schema-3 proof naming serving B, the
unchanged A import receipt, and the separately verified sequence-zero current
head. A B-scoped lease MUST fetch the original protected
commit through real Git upload-pack while receive-pack, cross-Project reads,
and protected-ref changes remain denied. An earlier-generation incomplete
import, foreign ref, or corrupt graph MUST refuse B startup before altering
the retained root. Host tests MUST keep the imported draft and bundle bytes
unchanged while replaying its exact proof and read lease under B. Fresh import
tests MUST prove the strict versioned policy stores each required job's name,
execution kind, and candidate-controlled evidence class; changing only a kind
MUST conflict without changing the draft, database, bundle, or ref. They MUST
reject a fresh flat legacy policy before state mutation. Completed legacy
imports and drafts MUST restart and retain exact read/proof receipts without
becoming required-job-kind authority, while pending legacy state MUST remain
non-runnable and refuse rollover. Real-Git proof tests MUST seed a finalized
sequence-one descendant and prove it across generation rollover while retaining
the byte-identical original receipt. They MUST deny an unrecorded ref, foreign
ref, wrong recorded tree, non-descendant head, and unresolved transition intent.
Host draft tests MUST read the finalized descendant while leaving the original
receipt and draft bytes unchanged. Authoritative candidate and review readers
MUST pin their expected protected head to that verified current head.
Installed workspace-write tests MUST issue through a distinct owner-host
credential only after a live authoritative import, use a canonical 43-character
base64url workspace ID, and push through real Git smart HTTP to that workspace's
proposal namespace. The same lease MUST fail direct protected-ref, tag,
foreign-workspace, deletion, and non-fast-forward force updates without changing
those refs. Tests MUST prove exact route/body parsing, known-role denial, expiry,
restart invalidation, shared read/write operation capacity, shutdown drain, Git
executable identity and hook enforcement, and continued absence of Project-ready,
reviewer, CI, or promotion authority.
Host-only native root snapshot tests MUST fetch the exact imported commit
through real Git HTTP, verify its commit/tree/blob object identities and
regular/executable modes, and publish a private read-only tree with safe
contained relative symlinks but no `.git` directory or persisted credential.
They MUST reject reserved lifecycle-path, absolute, dangling, and escaping
links, gitlinks, oversized objects, unsafe existing targets, and a protected
ref moved during lease-backed verification without publishing a snapshot or
leaving a staging artifact. Cache reuse MUST validate the existing tree
without minting another lease. Neither a successful fetch nor a snapshot
creates a runnable native Project, writer, reviewer, promoter, or CI admission.

The installed control-plane gate MUST also inject a lost candidate activation
acknowledgement after both exact service activations, observe retention of the
published candidate and transaction journal without automatic prior rollback,
and use the packaged facade's explicit `installer recover control-plane
--roll-forward --generation GENERATION` command to replay only that candidate.
A wrong generation MUST leave the journal, containers, snapshots, and volumes
untouched. Exact recovery MUST remove only the journal after rechecking both
owned runtime identities and readiness, preserving volume identities and
sentinels. Fixture tests additionally cover first installation, partial
activation, multiple retained historical generations, and malformed journal,
snapshot, Compose, or runtime evidence. These Docker and Git checks are not
the clean-host real Sysbox and accessible-KVM native Project cutover gate.

Until the native Project/repository state adapter has its own approved contract,
the gate MUST prove that Project/repository admission, native webhook demand,
host-capacity advertisement, claims, attempts, and result reports all fail
before service-state, runtime, or protected-ref mutation. Credential tests MUST
separately prove that identity cannot issue or report, attempt issuer cannot
report, result reporter cannot issue or revoke, native query cannot mutate, and
none can read Git, approve, promote, administer, or cross a configured tuple.
There is no successful native ordinary job or two-host execution acceptance in
this installer-only gate; that evidence belongs to the future adapter contract.
The installed reader's admission-discovery POST MUST return only the current
active, unexpired Project/root admission for the exact activated installer
generation and capacity digest. Tests MUST prove that discovery with a foreign
credential or Project, stale generation, expired or revoked admission fails
without inserting a request-replay row or mutating admission state. Discovery
is not admission registration, event delivery, claim, or job acceptance.
The gate MUST prove the bounded predecessor-state preflight runs before config
reading, Docker, lock creation, staging, or installer-state mutation. Presence
of `DIM_ORDINARY_CI_POOL_CONNECTION_FILE`, including an empty value, MUST refuse
without opening the referenced path. One canonical Project-scoped schema-8
Sysbox runner record, including a stopped runner, MUST refuse byte-for-byte
unchanged and without a Docker call. One valid schema-8 QEMU runner record MUST
permit normal idle installation and remain byte-for-byte unchanged. Symlinked,
malformed, foreign-owned, wrong-mode, unsupported-schema, unknown-executor, and
otherwise unclassifiable canonical runner records MUST fail closed unchanged.
First installation MUST refuse a pre-existing fixed ordinary-CI volume rather
than adopt it. Image-level read-only state probes MUST separately prove that
schema-less, schema-1, predecessor schema-2, missing-marker, malformed-marker,
and schema-mismatched ordinary database fixtures are rejected without database,
WAL, SHM, marker, or volume mutation, while the exact current marked format is
accepted. No acceptance case is required to discover an arbitrary predecessor
config, database, or process outside the explicit environment selector,
canonical DIM lifecycle state root, and fixed control-plane Docker resources.

The future adapter gate MUST additionally prove descriptor equality across
native Git, scheduler, and host parsing; direct argv execution without shell
construction; exact candidate checkout and config/script blob identities;
digest-pinned operator job and runner-base images; effective
CPU/memory/PID/time/output bounds; absence of every host socket, `/dev/kvm`,
secret, and reusable credential; and owned cleanup after success, failure,
timeout, signal, lease loss, and result-submission failure. It MUST reject an
old generation, revoked/old/future attempt, changed descriptor, conflicting
replay, different host assignment, earlier success after retry, and any result
whose candidate/config/script/operator-image/argv/base/bounds identity differs. It MUST
prove that exact replay is idempotent and that a current zero-exit result may
satisfy only a policy job explicitly classified `candidate-controlled`, while
human approval and CAS remain independently required.

For `CI-NATIVE-DELIVERY-001`, the future adapter gate MUST use the real native
outbox, ordinary SQLite inbox/scheduler, two controller identities, native
attempt API, ordinary reporter, and native terminal-status API. It MUST prove
the exact event has no executable or authority-bearing field and that adding
any image, argv, command, script, path, environment, mount, network, URL,
resource, host, capacity, credential, or unknown field rejects before inbox
mutation. Policy membership MUST admit bounded use of the global configured
capacities without storing or accepting a per-Project eligible-assignment list.
Candidate config and script remain candidate-controlled provenance and MUST
NOT be reported as trusted because the Project is admitted. The job and
runner images must match the operator-owned capacity, not a candidate field.

Idempotency tests MUST crash or kill the responsible process after each of
these durable boundaries: native event publication, ordinary inbox commit,
claim-receipt commit, descriptor response, native attempt issuance, assignment
plus claim commit, host-result plus report-outbox commit, native status commit,
and ordinary release commit. Recovery MUST reuse the same event ID, host request
ID, claim ID, issuance request ID, attempt ID, descriptor digest, and terminal
event where applicable. The mandatory claim case kills ordinary CI after native
issuance but before assignment commit; retry must reuse `claimId` as
`issuanceRequestId`, obtain the same attempt, and create exactly one assignment
and claim. No crash may execute one demand twice, replace an earlier result,
lose an accepted report, or release capacity before durable cleanup evidence.
The webhook replay case MUST withhold every native delivery acknowledgement,
complete attempt `A1`, advance beyond seven days, prune all eligible detailed
inbox/demand/claim/result rows, and replay both the original event ID and a new
event ID with the same review/job tuple. Permanent `(eventId, eventDigest)` and
`(reviewId, jobName, tupleDigest)` fences MUST return the original acceptance
without creating demand `D2`, claim `C2`, or attempt `A2`. A changed digest
MUST conflict.

G1 tests MUST rotate admission after policy, expiry, revocation, and global
capacity changes, and MUST restart ordinary CI with queued, preparing, active,
and reported work. Old queued demand becomes terminal without requeue; a
preparing receipt either resumes under the unchanged generation or revokes its
issued attempt; every old or restart-observed active claim fences only its exact
host/capacity. The same host may clear that fence only after exact owned-resource
inspection and cleanup. Absent owned residue succeeds, while partial,
mismatched, ambiguous, and foreign residue remains untouched and fenced. Other
capacities continue to claim work.

The API matrix MUST test missing/invalid authentication as `401`, every
webhook/query/identity/issuer/reporter/admission/host role crossover as `403`,
foreign scope as concealed `404`, stale or conflicting state as `409`, bounded
store saturation as `429`, and unavailable native proof or database durability
as `503`. Syntax, media type, and size denials are `400`, `415`, and `413`.
Every case must prove no forbidden row, native evidence, runtime, or protected
ref mutation. Exact event, claim, renewal, result, recovery, descriptor,
issuance, proof, and report responses reject extra fields and redirects and
remain within 64 KiB.
`attemptIssuer` MUST be the only service credential accepted for descriptor
derivation and for exact attempt issuance/revocation. It MUST be denied report,
Git read/write, review inspection/approval, promotion, and administration.
Identity, webhook, reporter, query, admission, host, reviewer, administrator,
promoter, and unrelated scheduler credentials MUST be denied descriptor
derivation.

Schema tests MUST compare an empty-created final schema-3 database with its
compiled manifest, then vary each table/index name, column order/type/
nullability/default/primary-key position, foreign key, unique/partial index,
and state check independently. Every variation, failed integrity check, failed
foreign-key check, schema-less file, schema 1, schema 2, and the unreleased
authority-only two-table schema 3 MUST be rejected from a read-only open before
WAL, SHM, pragma, repair, or byte mutation. There is no migration acceptance
case. Bound tests fill 10,000 nonterminal demands, each 100,000-row compact
replay-fence table, 100,000 age-prunable terminal-detail rows, and 100,000 claim
receipts. An unseen event requiring a new fence MUST receive `429` without
eviction, while every known exact replay still receives its original acceptance
at the cap. After seven days, pruning may remove only terminal dependent rows
whose event and review-job fences exist and remain byte-for-byte unchanged.

One end-to-end success MUST observe native event acknowledgement, one host
claim, strict host reparse and exact descriptor equality, direct fixed argv,
owned cleanup, durable report retry through an injected native outage, native
terminal acknowledgement, and capacity release. Reviewer and promotion output
must show `candidate-controlled` config/script and operator-image/argv provenance. Human
product/test review and exact final CAS remain separate required evidence. The
same fixture must show that optional QEMU state never enters the native inbox,
claim, report, or promotion path.

The existing Gitea `ordinary-ci-pool-live` fixture is predecessor evidence and
MUST NOT satisfy this gate. Shared-QEMU scheduler gates remain Gitea-only,
report missing KVM as unavailable rather than passing, and MUST NOT run with
native selection, create native ordinary evidence, or join the control-plane
Compose project.

## Gitea-free native Project and QEMU cutover gate

**VERIFICATION-NATIVE-CUTOVER-001 (target, not implemented):** This gate is
separate from the installer-only bundle gate and the predecessor Gitea
ordinary/QEMU gates. It MUST run the packaged facade and the real activated
native services on a disposable clean Linux host with Sysbox and accessible
KVM, without importing or adopting any existing Gitea data. A source-only
unit suite, simulated Docker runner, two logical hosts on one daemon, or idle
service readiness MUST NOT count as acceptance. The gate MUST record the exact
source/package/image digests, host runtime capabilities, effective container
configuration, and complete cleanup outcome.

The successful journey MUST create a fresh native Project and root repository
through trusted host administration, import or seed one reviewed protected
head, create a workspace, read its exact protected snapshot, and push a
proposal from the agent without a registrar, reviewer, promoter, host, or
service credential in that workspace. The same writer MUST fail to update or
delete the protected ref, force a proposal, write another workspace's
namespace, or read a foreign Project. A human must inspect the complete exact
candidate tree and CI provenance through the supported CLI or scoped reviewer
page, approve the exact review, and perform a separate checked promotion.
After promotion, a new protected-root read MUST return the promoted tree;
changing the protected head or policy between approval and promotion MUST
leave the ref unchanged.

The gate MUST observe automatic CI eligibility for a trusted native Project
without Project-specific CI approval, Gitea registration, webhook, or runner
token. It MUST run one ordinary Sysbox job and one QEMU VM job from separate
named capacities using operator-owned digest-pinned common runner and job base
images. A different Project with candidate-supplied image or resource fields
MUST NOT widen these global choices. Both executions MUST verify the exact
candidate commit/tree and script blobs, use runtime-fixed argv, enforce
CPU/memory/PID/time/output ceilings, and record the selected test definition,
actual base digests, execution kind, bounds, exit status, and attempt/generation
identities. Their results MUST be labeled `candidate-controlled`, including
the QEMU result. The VM MUST receive no host Docker or hypervisor socket,
`/dev/kvm`, raw DIM or Git credential, reviewer identity, or promotion
authority; the host-owned trusted
supervisor alone receives `/dev/kvm`. Ordinary jobs MUST have no `/dev/kvm`
or QEMU capacity authority.

When protected policy requires both named jobs, promotion MUST fail before
ref mutation for each independently injected missing, failed, wrong-kind,
foreign, stale-generation, old-attempt, mismatched-descriptor, and replayed
success result. The ordinary result MUST NOT satisfy the QEMU slot or vice
versa. A missing or inaccessible `/dev/kvm` is an unavailable QEMU gate, not a
passing one; when QEMU is policy-required, it MUST leave promotion blocked.
Optional QEMU failure remains visible without changing the ordinary requirement
or exact human approval. Reviewer and promotion output MUST distinguish
candidate-controlled evidence from independent verification and must not
present a common base image as proof that candidate-selected tests are correct.

Restart/crash injection MUST cover native Project registration, review/job
event delivery, both schedulers' claims and renewals, attempt issuance, VM and
Sysbox cleanup, terminal-result publication, and final promotion. Exact replay
converges on one current result; uncertain ownership fences only its capacity
until the same host inspects and reaps the exact owned resource. Foreign or
ambiguous same-name container, network, volume, or state remains untouched and
blocks only the affected action. No partial failure may convert an old QEMU
result into ordinary evidence, release uncleaned capacity, or skip checked
promotion. The effective runtime and traffic inspection MUST find no
`dim-gitea`, Gitea database, Gitea credential, Actions registration, Gitea
webhook, provider fallback, or predecessor QEMU selector in the native
journey. Existing Gitea resources on another installation MUST never be
removed merely because this native gate passed.

Parser-only native QEMU checks MUST reject wrong-host or duplicate capacities,
unsafe/linked/overpermissive connection files, noncanonical host tokens,
untrusted endpoints, mutable base images, candidate resource overrides,
Gitea Project/webhook/registration fields, and native lifecycle selection
without an implemented adapter. Those checks and simulated claim/recovery
tests are preparation for `VERIFICATION-NATIVE-CUTOVER-001`, never real Sysbox
or KVM acceptance evidence.

For `TRUST-RUNTIME-001`, each implemented backend MUST run the same
backend-neutral agent journey. A supported VM backend additionally requires a
KVM-capable host gate covering create, stop, start, restart, host reboot,
persistent data, guest-private Docker, network targeting, resource limits,
memory reclamation, and ownership-safe failure recovery. From inside the guest,
the gate MUST reject or prove absence of raw secrets, secret volumes, host
Docker and hypervisor sockets, host-admin and workspace-controller grants,
`/dev/kvm`, promotion credentials, and other-workspace data. The trusted
Project hook and secret-bearing service MUST execute outside the guest from the
approved immutable root. Missing KVM reports blocked and is not passing
evidence.

For `STATE-BACKEND-001`, compatibility tests MUST preserve the exact bytes and
resources for historical `sysbox`, cross-backend, unknown-schema, unknown-field,
and mixed-label input while rejecting before runtime, plugin, or hook mutation.
An implemented `container` release MUST prove that it neither aliases nor
silently relabels historical `sysbox` state. Export/discard/create/restore is a
separate explicit journey; it is not a parser migration test.

For `WORKSPACE-AUTHORITY-001` and `URL-APPROVAL-001`, one continuous journey
MUST distinguish stop/start of one workspace ID from discard and same-name
creation of a fresh ID. It MUST prove that declared retained data and agent
home bytes survive `--keep-volume`, while old grants, tokens, sockets, route
IDs, approvals, slugs, permalinks, device grants, and runtime generations do
not authorize the new instance. An approval-required route MUST be unreachable
in `pending`, reachable only after host approval, unavailable while stopped,
restored only for the same approved route tuple on same-instance start, and
unreachable after revocation, target drift, discard, controller restart while
pending, or same-name recreation. A forged cross-workspace approval MUST fail.
Hostname-route evidence MUST exercise the policy-selected slug and stable
permalink through real HTTP and WebSocket listeners, prove that both authorities
share approval, target rebinding, revocation, and active-flow closure, and prove
that dual-authority collision checks do not leave a partial claim. It MUST show
that same-instance slug policy drift retains the route ID and permalink while
requiring fresh approval, and that same-name recreation receives a different
permalink. Raw TCP evidence MUST show that no hostname permalink is created.
Real-controller concurrency tests MUST also prove that setup can resolve a host
input while it owns the workspace setup lock, and that a valid agent grant with
an incomplete or oversized request body never acquires workspace authority or
delays durable discard denial.

For `PROJECT-HOOK-DEFAULTS-001`, every backend MUST test hook-present, Compose
fallback, no-op setup, entrypoint-present, direct-command fallback,
teardown-present, and Compose/no-op teardown cases from one immutable root.
Guest mutation, symlink escape, moved root, and missing lifecycle-file probe
failure MUST start no trusted hook. VM evidence MUST show that hook authority
and secret-bearing operations remain outside the guest.

## Scope

This specification defines the minimum verification gates for development.

## Example runner

`verification/scripts/verify-example.bash` is the common entrypoint for runnable examples.
It accepts `current-installed` and `sysbox`. The named backend provisions an independent disposable QEMU guest for
each selected example, while an optional example selector narrows the
otherwise compatible suite. Its dirty-repository policy is `auto`, `use`, or
`discard`: `auto`
rejects dirty input, `use` snapshots tracked and non-ignored untracked files,
and `discard` verifies committed `HEAD` without changing the checkout.

Repository-backed examples use `repos/<alias>`. The common fixture code must
initialize every alias as an independent Git repository, update matching
entries in the root `repos.yml`, and register that reviewed set in the
verification run's disposable managed Gitea.

The QEMU wrapper owns only guest and toolchain provisioning. After installing
Sysbox, Node.js, pnpm, and `just`, it must invoke repository
verification through `just install` and `just verify example`.

`project-runtime-cgroups` is one leaf feature example. Its systemd, cgroupfs,
and unsupported variants are files within that leaf and the common example
runner must dispatch its contract smoke for both direct selection and the
compatible `all` suite. Because the contract smoke is backend-independent, a
named backend may run it without provisioning a dedicated QEMU guest.

## Source Check Gate

`just check-source` must run:

1. TypeScript check.
2. Unit tests.
3. Production build.

Current commands:

```bash
just typecheck
just test
just build-packages
```

This gate must require only Node.js and pnpm, not Docker, a runtime backend,
QEMU, KVM, or an installed DIM CLI.

The source gate MUST require zero multi-module runtime strongly connected
components in the core and CLI source graphs. Its graph check MUST follow
relative runtime imports and re-exports recursively while excluding type-only
edges, and its own fixtures MUST prove that a nested cycle is detected.

Local source-preparation tests MUST accept only `DIM_SOURCE_ROOT_COMMIT` as an
optional exact 40-character commit, defaulting to the current reviewed root
monorepo commit. They MUST prove that preparation archives that one commit
without cloning historical split repositories and derives the shared local
package and image version from the SHA-256 digest of the root commit record
plus the SHA-256 digest of the reviewed aggregate dependency lock. Executable
tests MUST prove that the archived production workspace installs with the
frozen lock. Two genuine reviewed commits whose committed aggregate lockfiles
differ MUST produce different aggregate local versions. Missing and stale locks
MUST each fail before package build, package publication, or image publication
without modifying tracked source. Real-Git tests MUST prove that replacement
refs do not change archived bytes, full-length tree object IDs are rejected
before dependency installation, and uncommitted lock drift does not alter the
selected commit. Symlink probes for persistent source, package, readiness, and
output paths MUST fail without changing their targets. Failed staging or late
publication MUST preserve recoverable copies of the previously published
packages and readiness. Tests MUST inject package and readiness restoration
failures and prove that recovery data remains at a reported private staging
path. The shared versioned image tag MUST be the final publication mutation.
Tests MUST prove that a concurrent foreign retag is never overwritten or
removed, and that an image-tag operation which reports failure retains the
prepared and prior private image references for explicit operator recovery
instead of attempting an unsafe shared-tag rollback.

`just verify workspace-user-setup` MUST supplement launcher mocks with the real
pinned OpenCode `1.18.31` runtime in a disposable home without provider
credentials. It MUST prove local and external unauthenticated `401` and
authenticated `200` responses, stable PID reuse, restricted state, absence of
credential disclosure, and process cleanup on a non-4096 loopback port. The
runtime lane MUST use the built `dim-development-service` and bound proxy,
observe a caller POST containing only `ingress` and the trusted proxy's target
injection, exercise HTTP and WebSocket forwarding, and prove that a second
non-OpenCode service retains its URL while changing local ports. Mock coverage
MUST separately exercise bounded lock, helper, and readiness failures plus a
same-credential unrecorded listener that remains alive and is never adopted.
The helper failure case MUST stall the helper process itself, complete within
the launcher's own deadline, and prove cleanup of the newly started tool.
The same gate MUST drive the actual canonical Project entrypoint with a
compatible setup/launcher fixture. It MUST prove `tool-setup` and `agent`
argument forwarding, unknown Project-task rejection, setup argument rejection,
canonical local-only setup ignoring stdin while `bash -s` consumes it,
successful version-1 manifest launch, and rejection of an unsupported contract
version, unknown launcher, symbolic-link manifest, mismatched tool identity,
mismatched version, mismatched executable path, executable symbolic-link target
outside canonical `HOME`, and non-executable target. Setup preflight MUST reject
escaping symbolic links at both `.local/libexec` and
`.local/state/dim-project-tool`. Static policy MUST prove that representative
Project examples own the explicit mapping, core defines no tool registry or
automatic setup behavior, and the optional Web launcher retains its configured
stable service name.

CI runner unit coverage must verify resource-default precedence, stable managed
names, and that default container arguments use the configured isolation
runtime without mounting the host Docker socket. It must also verify that the
host-scoped pull-through cache has no published port and that Sysbox and QEMU
runner daemon configuration selects only the internal cache endpoints. For
`CI-CACHE-ROUTING-001`, verification must prove that managed workspace and
Sysbox daemons discover `dim-registry-cache:5000` directly, nested agent DinD
uses a workspace-local relay, and QEMU uses its launcher-local relay. Each route
must provide separate cold, warm, stable-alias replacement, and outage
evidence: the cold pull reaches the cache and requests its upstream artifacts,
the warm pull reaches the cache without another upstream artifact request, a
cache address change retains routing through the alias, and an unavailable
cache or relay fails without direct upstream bypass. Project examples must not
embed cache configuration. Packet capture and general network monitoring are
not required.
`cache-routing-sysbox` remains a direct, capability-gated local recipe. It MUST
require a real Sysbox-capable Docker host and MUST NOT be scheduled on the
QEMU-backed `dim-container-integration` hosted lane. A missing local capability
is a failed prerequisite, not passing evidence for `CI-CACHE-ROUTING-001`.

Managed Git verification must distinguish the host maintainer from the
workspace writer and verify that reviewed-ref push options allowlist the host
maintainer and organization Owners while force pushes remain disabled. It must
also verify that baseline-protected refs allow ordinary writer pushes but
reject force pushes.
Project identity tests MUST prove that schema `4` requires nullable
`giteaOrganizationId`, rejects null for `ready`, and rejects older schemas.
Creation tests MUST prove that the exact positive organization ID returned by
Gitea is persisted in a non-ready record before `ready` publication. A retry
with that ID MUST issue no creation request and MUST accept only a response
with the exact stored ID and reserved username. A null-ID creation receiving
HTTP `422` MUST require administrator reconciliation without a lookup or name
adoption. Managed Gitea verification MUST also prove that regular users cannot
create organizations through Gitea's
`[admin] DISABLE_REGULAR_ORG_CREATION` setting, mapped exactly as
`GITEA__admin__DISABLE_REGULAR_ORG_CREATION=true`.
Managed Gitea concurrency tests MUST prove that one service-scoped lock spans
service-state claim and error/ready publication, network and volume
reconciliation, container inspection and creation, organization-policy
inspection and repair, restart, readiness, credential read or publication,
and webhook configuration. Waiting reconciliation MUST issue no interleaved
inspection or mutation. Container start, policy inspection and editing,
restart, and credential access MUST use the immutable ID returned by the
owned-container inspection. Credential tests MUST create credentials only
after the reserved genuine missing-path result and MUST propagate every other
read failure without user or credential mutation. Policy tests MUST accept
exactly one `[admin]` `DISABLE_REGULAR_ORG_CREATION=true` entry, reject missing,
false, or duplicate entries, and reinspect that same policy after restart
before readiness, credentials, or ready-state publication.
Managed Gitea resource tests MUST prove that network or volume creation occurs
only for the trimmed, case-insensitive exact Docker absence diagnostic for that
resource's expected type and name. They MUST reject daemon connection and
permission failures, wrong names, wrong resource types, and prefixed or
suffixed absence text without mutation or later reconciliation.

Git-host synchronization verification MUST drive the authenticated HTTP
service and CLI surfaces against disposable Git and Gitea repositories.
Repeated fetch and publish operations MUST use the same actual bare repository,
retain one credential-free deterministic remote, create no full temporary
clone, remove the hidden staging namespace, preserve unrelated and protected
refs, reject tag conflicts, and reject non-fast-forward publication. Gitea
integration MUST prove that visible updates traverse receive hooks and refresh
provider-visible branch state. Boundary tests MUST reject unknown aliases,
caller-selected paths, disallowed transports, credential-bearing URLs,
malformed mappings, arbitrary refspecs, redirects, oversized bodies, wrong
tokens, concurrent same-repository requests, and timeout residue. Tests MUST
inspect persistent Git configuration and service output for credential
absence.

The Sysbox lane of `verification/scripts/kvm-host-install-smoke.bash` must enable a real
Project CI runner inside its disposable QEMU guest and inspect the effective
Docker runtime, CPU quota, memory limit, PID limit, non-privileged flag, and
absence of a host Docker-socket mount. It must then run the CI runner feature
smoke against a non-root repository.

`just verify example sysbox DIRTY ci-runner` must register one
organization-scoped runner
for a multi-repository Project, open a pull request in a non-root repository,
and wait for that repository's real workflow to succeed.

Predecessor Gitea ordinary-pool regression tests exercise two independently
identified hosts and two reviewed organizations:
each host must be able to run an ordinary job for the other host's Project
without adopting its local Project record. Tests MUST reject a foreign
organization or mismatched organization ID, a mismatched host binding, an
unknown host or capacity, mutable images, unauthenticated webhooks, and an
instance-wide runner registration. They MUST prove exclusive claims and
durable queue state across service restart, expired-claim fencing until
ownership-safe container cleanup, lease-loss termination before release,
and preservation of foreign same-name Docker resources. Runner argument
inspection MUST exclude the host Docker socket and `/dev/kvm`, prove Sysbox
and cgroup limits, verify temporary registration-token cleanup, and prove
that its nested daemon uses the host registry cache and fails without direct
Docker Hub fallback when that cache is unavailable. A same-name Gitea
organization replaced with a different ID MUST fail before token request.
`in_progress` MUST permit renewal while a completed claimed job MUST reject
renewal. Normal completion with an in-flight renewal MUST NOT report lease
loss. Host maintenance MUST exclude disposable pool containers from restart
state, stop them, and block new claims until the host is ready again.

This Gitea organization/registration fixture is retained only as predecessor
regression evidence. It does not satisfy `CI-ORDINARY-POOL-001` after native
control-plane selection and MUST NOT be reported as the control-plane bundle
gate. The target evidence is the native Project/repository and exact-attempt
journey in [Control-plane bundle gate](#control-plane-bundle-gate).

Source integration tests MUST run the production registrar against disposable
protected Git roots and a real loopback HTTP Gitea API fixture. They MUST prove
that two Projects are automatically admitted from exact protected commits and
config digests, that the service receives no Gitea credential and issues no
runner-registration token, and that a foreign organization, mutable or
different common image, stale config admission, service/host mismatch,
revocation, expiry, and lease loss all reject before Docker launch or runner
registration. Restart tests MUST inspect durable admission, queue, and claim
rows and prove that old work remains preserved but inactive rather than being
migrated, deleted, or rebound. Live HTTP and SQLite tests MUST prove that an
active identical-policy refresh retains its admission generation and webhook
secret, while identical-policy re-admission after revocation or expiry creates
a fresh random generation across restart. They MUST also prove recovery of an
expired claim from the old generation removes that claim without requeueing it
under the replacement generation. The obsolete static-enrollment SQLite schema
MUST be rejected byte-for-byte unchanged.

The disposable-QEMU Sysbox gate runs `just verify ordinary-ci-pool-live`
before other guest work. It MUST use a real Gitea service, organization
webhooks, two Project workflows and ephemeral Sysbox runners, prove cross-Project
dispatch for two distinct host identities, and inspect resource and device
boundaries. These two identities share one disposable guest and Docker daemon;
passing this gate MUST NOT be reported as the independent two-physical-host
deployment proof below.

Before accepting a live pool deployment, a separate Sysbox-capable host gate
MUST use the actual external Gitea service and two DIM Projects on at least
two hosts: deliver authenticated organization webhooks, run a real workflow
from each Project on the other host, inspect the effective runner runtime,
mounts, CPU, memory and PID limits, and confirm that an unrelated Gitea
organization cannot dispatch into the pool. Interrupt one worker during a
claimed job, then restart it and verify that its owned container is reaped
before that host capacity accepts another claim, while the other host
continues to serve. A fake Docker
runner or simulated Gitea endpoint is useful unit evidence but is NOT
evidence that the live Gitea/Sysbox isolation boundary works. Keep the QEMU
integration gate separate until shared QEMU scheduling is explicitly adopted.

`just verify plugin-install` builds the publishable packages and verifies
plugin installation through their packaged shape. It is separate because it
tests an installation workflow rather than source correctness.

The external URL plugin unit suite must exercise real HTTP forwarding through
configured listeners sharing the hostname registry, generated URL shape,
concurrent automatic-name allocation, default workspace-prefix rejection,
webhook approval and response bounds, forwarded-header normalization, and
independent route claim revocation. For `CLI-EXTERNAL-URL-HOST-LIST-001`, CLI
and plugin tests MUST prove a two-workspace host inventory with Project and
workspace names, unchanged single-workspace listing through `--workspace`,
denial of the host action through a workspace or agent grant, missing-plugin
failure, omission of internal identity and claim fields, and rejection above
the 1,000-route bound. The Cloudflare plugin suite must verify named driver
registration, provider/record argument normalization, and DNS reconciliation.
For `CLI-EXTERNAL-URL-TCP-001`, the suite MUST exercise authenticated raw TCP
forwarding, rejection before a valid claim, exact-target idempotence, collision
rejection, replay of the existing route identity without duplicate persistence
or rollback of an already-owned claim, active-flow disconnection on revocation
and shutdown, maximum connection enforcement, connect and idle deadlines,
same-claim nested-runtime replacement behind an unchanged relay with old-flow
disconnection, other-claim rejection, and persisted-claim reconciliation. The
suite MUST also prove that authoritative workspace discard revokes routes when
the workspace grant is absent, and that ingress removal closes its listener,
purges its persisted routes and claims, and prevents resurrection after re-add.
For
`CLI-EXTERNAL-URL-TAILSCALE-001`, it MUST prove status-only CLI invocation,
running-state and CGNAT address validation, exact-address binding data, and
high-port validation without host Tailscale mutation.
The generated QEMU webhook asset suite MUST execute the emitted Python program
and verify monotonic workflow-job transitions across duplicate, reordered,
concurrent, and post-restart deliveries, including bounded terminal retention,
without replacing its file lock or atomic state-write path with a test double.
It MUST prove that the scheduler fsyncs its temporary state file, atomically
replaces the durable file, and fsyncs the containing directory before HTTP
`202`, and that state load or write failures reject acknowledgement. Scheduler
tests MUST also prove that a claimed job ID is only a demand trigger: swapped
coordinator assignments, trigger completion, and missing or replaced trigger
claims MUST leave every already-running generic capacity alive, while one-VM
per-capacity, shutdown, state-I/O failure, and process cleanup remain enforced.
Shared-scheduler tests MUST also execute two independent host clients against
the packaged HTTP service and prove one claim per capacity, restart durability,
idempotent retries, lease expiry and fencing, authorization boundaries,
bounded input, and process-group termination after uncertain renewal. They
MUST prove scheduler tokens are absent from the child environment and local
stop or deletion cannot remove a central webhook used by another host.
The Docker integration lane MUST build the shipped scheduler image and execute
two generated shared-worker programs with distinct host identities and one
Project API token. It MUST prove authenticated readiness only after scheduler
exchange, one claim, terminal retry convergence, detached one-job process
survival, and one host stopping without disrupting the other host or the
central webhook. This fixture MAY replace QEMU with a fake one-job process and
an accelerated monotonic clock; when it does, it MUST state that it verifies
packaging and shared-worker coordination rather than a QEMU or KVM boundary.
The same lane MUST exercise two isolated controllers against one disposable
external Gitea service, including shared administrator and maintainer
credentials, host-authorized remote deletion, independent stale local records,
and one host shutting down without stopping the service or the other host.
Protocol tests MUST reject redirects, oversized or non-exact responses,
sub-60-second leases, API-authenticated non-queued transitions, and MUST
acknowledge unrelated queued labels without creating demand. Fake-clock tests MUST cover the
takeover grace and one-time restart hold without real-time waits. They MUST
also prove direct running events count toward the 10,000-job nonterminal cap,
released claim churn reaches the 100,000-receipt cap, saturation preserves live
fences, and retention restores admission. Lifecycle tests MUST prove local to
shared, shared to local, Project-ID, host-ID, and external-Gitea-host-ID changes
fail before runtime mutation. Shared-worker tests MUST prove an unsuccessful
supervisor releases only after termination and reaping and cannot start another
supervisor before bounded shutdown-interruptible backoff.
The route-policy test launches the checked-in advanced example server rather
than maintaining a test-only webhook implementation.
A Docker-capable lane MUST run `just verify headscale-tailnet-tcp`. It MUST
install the packaged plugin in a digest-pinned Node/Tailscale host, invoke the
compiled Tailscale status driver and `TcpIngressListener`, and register that
host plus a client against disposable digest-pinned Headscale. The listener
MUST forward a unique sentinel to a separate target attached only to a private
non-tailnet network, then fail reachability after route revocation. The fixture
MUST inspect that target for absence of Tailscale credentials, state, socket,
binary, and mounts, and MUST neither read nor change host Tailscale state. A configured
operator-owned Tailnet ingress can additionally run:

```bash
verification/scripts/tailscale-external-url-smoke.sh
```

That smoke starts a workspace service, provisions a Tailscale URL through the
controller API, fetches a unique sentinel through the external URL, and revokes
the route. It is required verification code but is not part of the static gate
because it depends on operator-owned Tailnet DNS and TLS.

## Managed Workspace Integration Gate

The container CI lane requires Docker with Compose v2 and support for privileged
nested containers. It runs source checks plus workspace image, nested Docker,
lifecycle, packed-project, shared-upstream, and cgroup verification. The
broader `just verify container` additionally covers the canonical self Project.
These recipes may run against the nested Docker daemon in a development
container and must not claim to verify a host runtime backend boundary.

Gitea runs this gate automatically via the Project-owned
`dim-container-integration` label from `.gitea/workflows`. That integration
label selects a fresh one-job QEMU guest, whose job container receives only the
guest-private Docker socket. Persistent Sysbox runners advertise ordinary
labels only and expose no job Docker host. The QEMU boundary runs the complete
stateful development flow and canonical self-Project contract with the runc
Project backend. GitHub automatic CI is
intentionally limited to Node.js type checks and tests that need no APT packages
or container runtime. Sysbox and KVM host-backend gates also remain available
through the manually dispatched GitHub workflows.

For `CI-JOB-IMAGE-001`, verification MUST reject absent, malformed, non-exact,
duplicate, mutable-image, and unknown-capability Project runner configuration.
It MUST prove exact-byte digest and protected-ref/commit provenance, one-snapshot
use for runner configuration and QEMU hook admission, and state schema `8`
round-tripping. It MUST prove that every Project label selects a digest-pinned
disposable job image and that no `:host` label is advertised.

Verification MUST build the generated runner host image, execute act_runner and
its required Docker CLI, and prove that Node.js, Git, `just`, `jq`, `socat`, and
`script` are absent. It MUST inspect the effective act_runner policy for
non-privileged jobs, no arbitrary valid volumes, bound job workspaces, forced
pulls, and no host Docker socket or runner host mode. Admission
tests MUST run every configured tool and capability probe through a separate
nested daemon and MUST prove that probe failure prevents registration.
Probe ownership tests MUST verify the complete DIM, Project name and ID,
capacity, executor, probe resource kind, Docker resource kind, and identity
digest label set. They MUST cover foreign same-name container and socket-volume
collisions, replacement of exact owned residue, a foreign resource winning a
same-name creation race, and a foreign replacement appearing before final
cleanup. They MUST prove that container removal settles before attached socket
volume removal, that container mutation uses the inspected immutable ID, and
that ownership-safe cleanup still attempts later resources after a partial
failure. Because Docker volumes have no immutable ID, tests MUST also prove
name-based volume removal is preceded by immediate ownership reinspection.
Every foreign resource MUST remain untouched, while cleanup removes only exact
owned residue.
QEMU service verification MUST prove exact root-owned namespace modes,
read-only exposure through both agent mount layers, four-path startup preflight,
descriptor-bound owner inspection and publication identity, preservation of a
replaced temporary owner path, listener inode pinning across unlink and rebind,
staged run-root activation and rollback, exact owner/socket/lease modes, and
launcher termination and run cleanup before lease-gated shutdown failure.
Executable tests MUST also prove that core dispatches setup and teardown with
`docker exec --user dim` from the immutable Project-root snapshot, while only
the defined QEMU operations elevate. They MUST prove the fixed
`/usr/bin/node` interpreter and `/usr/bin/env -i` environment isolation with
explicit `PATH` and `HOME` for root Node and shell commands.
QEMU tests MUST prove selection by either an integration label or `dim-qemu`,
supervisor-side `register --ephemeral` after guest readiness, strict validation
of the temporary `.runner`, and transfer of only that file into the guest.
They MUST also prove that guest transports and QEMU lack the reusable token,
the guest runs `daemon --once` under a timeout, and each job receives fresh
overlay, SSH, registration, and run state with bounded teardown.
For `CI-QEMU-BACKLOG-001`, deterministic tests MUST cover more than 100 queued
jobs while the ascending-ID queue shrinks between requests. They MUST prove
validated effective page sizing, fixed last-to-first enumeration, first-page
retention, cross-page deduplication, and no replay before enumeration completes.
They MUST reject malformed jobs, duplicate-only incomplete coverage,
inconsistent counts, foreign or malformed `Link` targets, and more than 100
pages without following a supplied URL. Create, start, and restart tests MUST
prove health and webhook installation precede enumeration, replay uses the
immutable inspected supervisor container and authenticated workflow-job
handler, successful replay precedes `ready`, and any enumeration or replay
failure persists runner phase `error`.

The automatic managed-workspace gate must also run the shared-upstream example smoke.
That smoke proves that two logical DIM repositories can share one external Git
upstream while fetch and push map only the branches and tags owned by each
repository namespace.

The multi-repository container smoke MUST dirty both a tracked file and a
non-ignored untracked file before requesting a workspace restart. It MUST
verify rejection without a container stop, Project-service replacement, Git
state change, workspace-record change, or setup invocation, then clean the
checkout and exercise the successful fast-forward restart path.

The stateful development-flow smoke MUST materialize
`examples/projects/full-development-flow` and exercise one continuous journey:
profiled resource-bounded creation, private nested Docker, dirty restart
rejection, a reviewed root update, stop/start persistence, controller socket
replacement, setup-error recovery, agent-home backup, discard, recreation,
restore, and final managed-state/resource cleanup. Failure hooks and managed CI
cache configuration MUST be injected only into its temporary repositories;
the checked-in example remains a normal user-facing Project. The Sysbox
installer lane in the release gate MUST execute this same journey after
installation and workload probes.

That live journey MUST also force the first `host start` to fail during one
workspace setup, invoke `host start` exactly once more, and prove that one retry
completes recovery. After the failed first call it MUST observe
`resumeWorkspaces` retaining exactly the selected workspace and both
`restartCiRunners` and `resumeManagedContainers` retaining their captured
values, which are empty in this journey. It MUST inspect failed-state evidence
without issuing an ordinary workspace admin operation while host admission is
closed. Only after the successful retry may it require all three arrays to be
empty and ordinary workspace operations to succeed.

Deterministic workspace recovery tests MUST prove that direct `setup` from both
`setting-up` and `setup-error` acquires the Project lock before the workspace
setup lock, revalidates Project and workspace identity while both are held,
and republishes the recorded immutable root and schema-3 runtime manifest
before Project setup and final `ready` publication. They MUST prove schema `8`
retains the root ref, exact commit, and canonical workspace-data
path without a repository catalog. The workspace must remain non-ready
throughout setup, moved root refs cannot change the recorded selection, and DIM
recovery MUST neither fetch nor resolve a non-root repository ref.

Lifecycle-file probe tests MUST cover `.dim/setup.sh`, `.dim/entrypoint.sh`,
`.dim/teardown.sh`, and `.dim/docker-compose.yml`. They MUST prove that exit
code `0` means present, only exit code `1` means absent, and every other exit
code aborts before hook, Compose, or direct-command fallback dispatch.

Workspace selection tests MUST prove that schema `8` records one immutable root
selection and the canonical persistent data path without a persisted snapshot
path, repository catalog,
or ref overrides. They MUST prove that older schemas and obsolete checkout
layout fields are rejected before mutation. An end-to-end two-repository
journey MUST prove that reviewed Project code selects the non-root ref,
materializes it under `DIM_WORKSPACE_DATA`, ignores hostile Git configuration
and hooks, leaves an existing checkout untouched, rejects a non-Git destination
without mutation, and can retry after failed staging.

Workspace resource ownership tests MUST verify the complete container and
inner-engine volume label sets from `WORKSPACE-RESOURCE-OWNERSHIP-001`,
including their deterministic identity digests. They MUST reject absent,
partial, malformed, foreign, or mismatched labels. Every container mutation
MUST be tested against an inspected ID while a foreign same-name replacement
remains untouched. Volume creation races MUST be followed by ownership
reinspection, and discard MUST reinspect the volume immediately before removal
so a foreign replacement remains untouched.

Repository deletion tests MUST prove that deleting the selected importing
target fails before Gitea or Project state mutation, while an importing sibling
does not block deletion of a ready target.

Deterministic host recovery tests MUST invoke `host start` twice after a
fault-injected first attempt. They MUST prove that a partial failure retains
all still-pending workspace, CI-runner, and managed-container recovery intent,
and full success alone clears all lists. Host lifecycle validation MUST accept
only schema `2`; require exactly its phase, workspace, CI-runner,
managed-container, and timestamp structure with optional string error; require
exact `{project, name}` runner targets; and reject missing, mistyped, unknown,
or invalid fields without mutation or dispatch. It MUST prove that a ready
runner absent from `restartCiRunners` is not restarted. Workspace
phase coverage MUST map `ready` to no action, `stopped` to start,
`setting-up`/`setup-error`/`error` to immutable setup replay, and `creating` to
fail-closed rejection. CI phase coverage MUST map `stopped` to start and
`creating`/`error` to ownership-safe stop then start for every recoverable host
entry phase. It MUST prove that a `ready` target is untouched when invocation
enters from `stopped`, `starting`, or `error`, but is normalized through stop
then start when invocation enters from `stopping`. An invocation entering from
host phase `ready` MUST dispatch no recovery. Ready targets MUST not be
disrupted on an ordinary retry. Runner normalization and QEMU reconstruction MUST inspect
complete ownership and act only on the inspected container ID before any
coordinator registration, authorization, or webhook mutation.
Host-state migration tests MUST use the historical shapes established by the
schema-`1` and schema-`2` revisions and prove that only `schemaVersion` and the
`resumeCiRunners`/`restartCiRunners` key change. They MUST cover valid schema 1
with absent and matching backup, valid schema 2 with absent and valid historical
backup, missing canonical recovery from a valid backup, idempotent repetition,
and concurrent callers. They MUST also prove that normal schema-`2` lifecycle
writes may diverge from the historical backup, that subsequent migration leaves
the current canonical bytes unchanged, and that the original backup remains
byte-exact and mode `0600`.
Concurrent reader evidence MUST contain only complete old or new canonical
bytes. Fault injection at backup publication and canonical replacement MUST
prove lock release and successful retry. Validation MUST reject without
mutation malformed JSON, unsupported schemas, every missing, mistyped, or extra
field, backup content conflicting with a canonical schema `1` record, wrong
backup mode, and symlink or non-regular canonical, backup, and recognized
temporary artifacts. Tests MUST prove that recognized regular orphan
temporaries are removed only after canonical validation and that unrelated files
remain untouched.

Managed-controller tests MUST prove migration occurs after PID claim and before
plugin load, route initialization, and listeners; success output occurs only
for migration or backup recovery; and failure names the migration startup stage
without executing plugin module side effects or creating listeners. Existing
normal-read rejection tests and every non-host schema rejection test remain in
force.

Host administration tests MUST prove that ordinary built-ins other than the
runtime-session exceptions, including lifecycle mutations, and plugin
operations acquire lifecycle admission before dispatch and retain it until
completion. Shutdown MUST wait before target capture while such an admitted
operation remains active. A later operation queued behind shutdown MUST reread
the resulting host state and reject without dispatch. Tests for
`workspace.run`, `workspace.exec`, and `ci.runner.logs` MUST instead prove that
the runtime-session path acquires admission, rejects without dispatch when the
observed host phase is not `ready`, and releases admission before streaming. A
deterministic blocked-stream test MUST prove that two independent runtime
sessions can both progress while lifecycle mutations remain exclusively
admitted; it MUST NOT assert that host readiness remains stable for the stream
lifetime or that a later stop/discard cannot interrupt it. Existing
operation-specific checks remain in scope, including workspace readiness,
ownership, and per-workspace locking. Health, readiness, route
discovery, host status, and command-session transport remain available during
maintenance. Recovery tests MUST also prove that `host start` can perform its
internal workspace recovery while ordinary workspace administration remains
blocked by the non-ready host phase.

Repository transfer tests MUST prove that an imported repository remains
non-ready while protection is pending, only the trusted transfer identity can
write before protection, and transfer authority is revoked before protection
is applied. Protection failure MUST leave the repository non-ready and deny
ordinary writer and maintainer access. Only successful protection may publish
`ready` and grant ordinary repository users.

The integrated development repository MUST expose a manually dispatched QEMU
release gate. The dispatch MUST pin the exact development commit and accept an
explicit root ref, while the reusable verification workflow resolves and
records the exact commit for every repository in the assembled set. It MUST run
one full integration lane selected by `dim-container-integration` and one host
installer lane selected by `dim-qemu` before that repository set is installed
on a host or applied by workspace restart. Both labels MUST start fresh one-job
QEMU guests and use the protected Project contract's integration image and
declared toolchain.

## Container Backend Gates

`verification/scripts/container-cgroup-smoke.bash` requires direct access to the target Docker
host and must cover exact runc cgroup v2 CPU, memory, swap, and PID limits,
including live resource updates.

`verification/scripts/container-sysbox-isolation-smoke.bash` requires a prebuilt workspace
image and direct access to a Docker host with `sysbox-runc`. It must cover:

- Sysbox system-container execution with explicit CPU, memory, and PID limits.
- Exact cgroup v2 limit visibility inside the container.
- Nested Docker `hello-world` execution.
- Bidirectional image-store isolation using unique host-only and inner-only
  probe tags, independent of pre-existing image caches.

The multi-repository Project example gate verifies managed Git, protected refs, and
trusted deployment of a reviewed secret-bearing child beside a Project-owned
agent. It must use the example's generated `repos.yml`, prove the agent uses a
distinct Docker daemon, cannot list the trusted workspace's secret-bearing
child, does not mount either Docker socket, and does not receive the child's
raw secret environment. Its shared bind-mount probe must work when the agent
UID differs from the rootless-DinD UID.
The rich-example gates MUST inspect each running daemon's actual `dockerd` and
RootlessKit argument vectors and kernel listener tables. They MUST prove that
only the reviewed Unix socket is configured, that RootlessKit forwards neither
2375 nor 2376, and that neither TCP port is listening. They MUST exercise
selected and cleared secure/documentation profiles, including removal of a
restart-enabled documentation child from persistent daemon state. Secret
operations MUST execute from the immutable selected root, while mutable-file
preservation probes MUST name the Project data checkout explicitly. Agent-home
archive verification MUST stop and restart the inner agent, then preserve both
file bytes and modes across restore. The built rich agent images MUST contain
the ACL utility their startup paths invoke. The gates MUST prove that an empty
agent-home root is initialized for the mapped inner agent owner, that populated
incompatible state fails closed without recursive ownership changes, and that
ordinary Project tasks and full-flow SSH retain their documented nonroot
identity and persistent-home access.
The single- and multi-repository example gates must also verify that their
fresh rootless-DinD images retain executable UID/GID mapping helpers with a
setuid fallback before exercising the private daemon.

For `LIFECYCLE-LOCK-001`, deterministic tests MUST prove that elapsed time
cannot reclaim a matching live process instance, a dead child and an injected
reused-PID identity are reclaimable, and simultaneous reclaimers remain
serialized. Tests MUST also cover malformed owner records, crash leftovers
during atomic publication, a malformed 36-character boot ID whose hyphens are
not in canonical UUID positions, same-process independent acquisitions,
bounded timeout, and a stale release nonce that cannot remove a successor. The
Project-to-CI-runner-to-hook-publication order, Project-lock release boundary,
and independent workspace setup/reconciliation identities MUST remain under
regression coverage.

The canonical self-Project gate must verify its healthy private rootless daemon
and inner UID-0 agent both after workspace creation and after the first
workspace restart, proving the persistent nested image store and
workspace-container lifecycle. The daemon UID and GID MUST match the reviewed
workspace checkout owner while the inner agent sees that checkout as UID 0,
and the disposable-QEMU lane MUST use UID 1001 so a default UID 1000 assumption
cannot pass unnoticed. It MUST also inspect the DIM-owned
workspace engine and verify that it selects the managed pull-through cache
without adding cache configuration to the Project definition. Canonical setup must explicitly
rebuild the outer private-runtime image and reconcile the inner agent image so
an updated entrypoint cannot leave stale inner workloads running. The agent
home volume MUST be writable by inner UID 0 through the daemon's mapped
workspace-owner UID/GID. The daemon's rootless socket and data directory remain
inside `agent-dind` and MUST NOT be replaced
with a host or trusted-workspace runtime socket.
For `PROJECT-AGENT-TMPDIR-001`, static self-Project and
full-development-flow tests MUST prove the dedicated volume name, ownership
label, local driver without options, distinct home and temporary mount
identities, `/mnt/opencode-tmp` bind mount, `TMPDIR`, pre-start validation, and
stopped-container removal in both ordinary and `--keep-volume` teardown
branches. A Docker-only runc driver MUST execute the production setup and
teardown scripts and prove that bytes survive private-daemon container
replacement, both discard modes remove the exact temporary volume after the
daemon is stopped without deleting agent home in keep-volume mode or an
unrelated Project volume, and a label-correct bind-backed temporary volume that
aliases the home path fails before the daemon starts. The agent filesystem
checks MUST additionally prove that `TMPDIR` differs from `/tmp`, the agent UID
can write a mode-`0700` root, and populated wrong-owner and symlink roots fail
closed. The Sysbox end-to-end gate MUST repeat the agent restart and discard
assertions on a capable host; an unavailable Sysbox or KVM environment is
blocked evidence rather than a pass.
The gate MUST also verify that workspace creation, setup, start, restart, and
update do not install coding-agent tools. The canonical workspace-user setup
script and its `.sha256` file MUST be published by the development repository.
Verification MUST invoke the script explicitly through the Project-owned
`bash` task, confirm its checksum before execution, and prove that all changes
stay canonically below the persistent agent home, including with adversarial
`XDG_CONFIG_HOME` and `XDG_CACHE_HOME` values and symbolic links. It MUST reject
cache paths that resolve outside the canonical home before npm runs, accept and
export the canonical target of a contained cache symlink, and verify the
canonical `$HOME/.cache` default. It MUST exercise relative, newline-containing,
outside-home, escaping-symlink, and contained-symlink values for both
`XDG_DATA_HOME` and `XDG_STATE_HOME`, including their `$HOME/.local/share` and
`$HOME/.local/state` defaults. Accepted values MUST be observed by npm as
absolute, newline-free canonical paths below `HOME`, and every rejected value
MUST prevent npm invocation. Verification MUST reject an existing symbolic link
at `$XDG_CACHE_HOME/opencode/packages/oh-my-openagent@4.19.4` for both contained
and outside-home targets, and MUST prove that preflight validation does not
create that coordinate. After destroying and recreating the inner agent
container, rather than merely starting another task process, verification MUST
observe the installed tools and configuration from the persistent home.

Static verification of that script MUST reject mutable package or source
coordinates, branch or `latest` download URLs, authentication commands,
global Git configuration, web-interface startup, and DIM controller, plugin,
token, or grant access. It MUST confirm pinned OpenCode and companion package
versions; home-confined XDG OpenCode configuration; and OMO 4.19.4 configuration
at `$HOME/.omo/omo.jsonc`, with `["[opencode]"].team_mode` settings of
`enabled=true`, `max_parallel_members=4`, `max_members=8`, and
`tmux_visualization=false`. Tests MUST exercise comment and unrelated-property
preservation, targeted plugin-option updates, serialized concurrent setup,
per-file failure cleanup, and retry convergence after a partial multi-file
run. They MUST NOT require multi-file transactional atomicity. This verifies a
Project bootstrap convention and MUST NOT add a DIM plugin, API, or lifecycle
interface.

Launcher verification MUST remain separate from setup verification. It MUST
cover invalid ports, missing prerequisites and development-service sockets,
startup failure and bounded authenticated readiness, unauthenticated HTTP
rejection, successful Basic Auth, mode-restricted persistent credentials and
logs, password-free routine output with explicit restricted-file retrieval,
HTTPS helper enforcement, exact process-instance reuse, stable named URL reuse,
and survival of unrelated processes. It MUST prove that launcher failure does
not stop the actual helper-managed shared gateway or another service routed
through it. At least one runtime lane MUST execute the pinned OpenCode
binary with no provider credential and observe both HTTP 401 without Basic Auth
and a healthy authenticated response. Setup-only lanes MUST continue proving
that no OpenCode listener starts. Verification MUST prove that the launcher
always supplies `https://localhost:4096`; accepts a JSON array of additional
exact HTTP or HTTPS source origins that defaults to `[]`; and normalizes,
deduplicates, and sorts the result before passing repeated `--cors` arguments.
Invalid JSON, non-origins,
user information, paths, queries, fragments, and wildcard values MUST fail
before credentials, logs, locks, or process state are created. The pinned real
OpenCode binary MUST demonstrate that `*` does not act as a wildcard.

At least one runtime lane MUST send a different-origin preflight and
authenticated request through the TLS generic gateway to the external URL. It
MUST observe a successful preflight that allows `Authorization` and
`Content-Type`, a CORS response for the configured client UI origin, HTTP 401
without Basic Auth, and HTTP 200 with the credential. The configured origin is
the requesting browser UI's source origin, not the destination external URL.
Verification MUST NOT assume that launcher origins exclude OpenCode origins
from built-in behavior or existing server configuration. It MUST also prove
that matching CORS configuration reuses the same process, while changed CORS
configuration restarts only the owned process and retains the credential,
stable URL, and shared gateway.

Static policy verification MUST inspect the root README and all three complete
Project example READMEs. Every copyable remote flow MUST create a host temporary
directory, install its cleanup trap immediately, derive each setup or launcher
script and checksum URL from one validated full development commit, verify all
checksums, and only then stream the verified local bytes through the existing
Project `bash` task. Setup and opt-in Web launch MUST remain separate commands.
Each example MUST show how to set `OPENCODE_WEB_CORS_ORIGINS` while streaming
the already verified launcher bytes, without relying on a script path that is
deleted after bootstrap.
The example READMEs MUST accept an operator-supplied, provider-neutral
raw-source root, normalize its trailing slash, and MUST NOT hard-code a Git
provider raw-content hostname. The root README MAY use DIM's canonical GitHub
raw source.

Verification MUST exercise remote-bootstrap failure and retry: a failed
checksum MUST NOT invoke the Project task, temporary downloads MUST be removed,
and retry MUST perform a fresh download and checksum verification before any
bytes execute. Script verification MUST also prove that the npm install prefix,
cache, and user configuration file resolve to canonical descendants of `HOME`,
that the npm cache and user configuration remain separate from
`XDG_CACHE_HOME`, and that the home-scoped serialization mechanism provides
flock-equivalent exclusive lock semantics through final installed-version
verification and releases ownership on success, failure, and interruption.

Project-runtime cgroup verification MUST cover both supported delegation
shapes (`systemd` and `cgroupfs`) and the unsupported `none` driver. The
checked-in feature examples MUST consume the same versioned Project manifest
contract and helper used by Project setup, and the negative example MUST fail
closed rather than silently running without resource enforcement.

## Fast Isolation Gate

`just verify isolation` must run without contacting Docker or creating a
container. It verifies generated runtime arguments, including:

- Outer CPU, memory, and PID limits.
- Job-specific workspace and nested runtime data mounts.
- Absence of the host `/var/lib/docker` as a mount source.
- Absence of the host `/var/run/docker.sock`.

`just verify isolation-json` runs the same tests with Vitest's JSON reporter so
CI can consume a single JSON document from stdout. These static checks do not
replace `verification/scripts/container-sysbox-isolation-smoke.bash`, which verifies actual
Sysbox and cgroup behavior.

## Backend Verification

Runtime backend verification should include:

- `doctor` for the installed backend.
- Workspace create, task execution, stop/start persistence, and discard.
- Nested rootless Docker smoke inside the Sysbox agent boundary.

Current verified host evidence:

- Sysbox inner Docker can run nested `hello-world` without access to the host
  Docker image store.
- Sysbox exposes the outer agent CPU, memory, and PID cgroup limits to the
  nested workload as aggregate upper bounds.

## Install Verification

Host installation scripts must be verified by:

- Checksum verification for downloaded runtime artifacts.
- Runtime version command after installation.
- Docker runtime registration check when the script registers a runtime.

`verification/scripts/kvm-host-install-smoke.bash BACKEND` and
`just verify environments-kvm BACKEND` verify one backend installer in a
disposable VM. Omitting `BACKEND` runs every backend in a separate VM. Managed
development CI MUST schedule each backend as an independent `dim-qemu` job so
available host capacities can run them concurrently without exposing capacity
names in tracked workflow code. These expensive jobs MUST run automatically
only for non-draft pull requests whose base is the managed development
repository's `main` promotion branch. Routine pull requests into `development`
retain source and managed-workspace verification without reserving
disposable-QEMU release capacity.
For `CI-QEMU-IMAGE-LAYERS-001`, verification MUST prove that the common-base
key changes with each pinned cloud image, provisioning, required toolchain, or
runner input and that the same key is reusable across Projects. It MUST inspect
the common base for absence of Project hook output, tokens, runner identities,
and job data. QEMU hook tests MUST reject unapplied protection and resolved
branches outside its patterns, prove one symbolic-`HEAD` resolution to a
concrete ref and commit, and prove that branch movement cannot substitute blob
bytes after admission. The Project-layer key MUST change with source ref,
source commit, hook kind, or exact executable digest and remain isolated per
Project. The absent case MUST stage, execute, and hash the same deterministic
non-empty no-op bytes. Tests MUST verify Project-to-CI-runner-to-hook-publication
lock order, Project-lock release before expensive image work, and complete
provenance in image manifests and runner state. Concurrent construction MUST prove locked, atomic publication. Deleting the
last Project QEMU capacity MUST remove only its Project-specific cache layer
and dispatch state. Every job MUST write only to a fresh disposable overlay.
Lifecycle tests MUST prove that QEMU `start` restores its persisted schema-`8`
config and hook artifact and provenance, supervisor image, job image, labels,
resources, and inheritance choice while replacing only runtime registration,
authorization, webhook, container, and resources. They MUST prove that
`restart` resolves the current protected state and refreshes every derived
admission input.
Common-base identity tests MUST independently vary both architecture names,
each cloud-image/checksum/signature/keyring input, the APT snapshot and exact
Deb822 source bytes, every requested package/version specification, every
downloaded executable URL and digest, each generated script, and the common
Packer template. Tests MUST reject `release/current` and other mutable image
aliases. Verification MUST check the official signed checksum metadata against
the selected artifact digest and trusted signing fingerprint, prove all APT
sources use one timestamped `snapshot.ubuntu.com` repository without disabling
signature verification, and prove every explicitly requested package is
version-pinned and available in that snapshot.
For `CI-QEMU-RESOURCE-OWNERSHIP-001`, tests MUST reject existing unlabeled,
partially labeled, malformed, wrong-owner, wrong-Project, wrong-capacity,
wrong-executor, wrong-resource-kind, wrong-Docker-kind, and wrong-digest
volumes and runner or supervisor containers for reuse and deletion. Every
generated short or long name MUST include a digest of all length-framed
identity inputs. Name tests MUST independently vary every input and include
distinct tuples whose naive delimiter-joined forms are identical. Container
tests MUST prove that start, stop, removal, QEMU reconstruction, and host resume
validate all nine ownership labels and use only the inspected container ID,
without a name fallback. Deterministic start and stop tests MUST cover foreign,
incomplete, and malformed same-name containers, plus a foreign same-name
replacement winning the race after inspection, and MUST prove each remains
untouched. Tests MUST prove absent stop is idempotent and absent Sysbox start
fails. QEMU reconstruction tests MUST prove complete ownership inspection and
selection of the inspected container ID precede coordinator registration,
authorization, and webhook mutation. Stop tests MUST prove
Project-to-CI-runner lock order. Tests MUST also prove that distinct valid long
names remain bounded and distinct, that failed and partially completed deletion
retains retryable runner state, that multiple capacities retain shared Project
resources, and that final-capacity deletion removes Project resources and local
Project image state without removing the host-common cache.
Every backend guest must run the same stateful development-flow and
`just verify self-development` recipe after the host installer completes. This
verifies the canonical DIM Project and its agent inside a private DinD on a
clean Ubuntu host. The guest verification user must use UID 1001. The gate
must prove that the canonical agent is UID 0 only inside its rootless
daemon, that the daemon's outer UID equals the non-root UID owning the checkout
(including verification UID 1001), and that Docker reports rootless security.
It must not treat inner UID 0 as host or trusted-workspace root authority.
The Sysbox guest must additionally verify a privileged trusted workspace using
its directly passed `/dev/kvm` with QEMU, absence of Sysbox registration in
the workspace's Project daemon, and a separate unprivileged Sysbox isolation
probe running a private DinD workload.
The self-Project integration gate MUST verify, after Project setup completes,
that the untrusted agent container has neither a `/dev/kvm` device nor readable
or writable access to that path. This is an agent-boundary regression test run
through a Project task; it MUST NOT run from Project setup or any workspace
lifecycle, readiness, start, or restart operation. KVM-disabled lifecycle
coverage instead asserts that DIM omits the explicit device and supplemental
group from the workspace creation arguments.

For `WORKSPACE-QEMU-INPUT-001`, the canonical Project MUST expose the protected
QEMU launcher through a workspace-local, single-run service. Admission tests
MUST prove that the first request claims the run synchronously before body or
filesystem work, a concurrent request is rejected, duplicate input names are
rejected before path resolution, and a rejected admission releases its claim.
Snapshot tests MUST prove that directory entries are streamed from open
directory handles rather than loaded as a complete listing, permission bits
are preserved, and symlinks are copied without dereferencing. They MUST cover
nested trees, immutable service-owned results after source replacement, a
socket, and a FIFO. A rejected unsupported entry and an interrupted snapshot
MUST start no subprocess or launcher and leave no reusable partial run tree.

Ownership tests MUST require a mode-`0600`, exact schema-1
`service-owner.json`. They MUST prove publication records schema 1 and the
launched PID as a decimal string, and MUST reject a missing required field, an
extra field, a numeric PID, a noncanonical executable path, and PIDs above
either kernel `pid_max` or the maximum safe integer. Tests MUST prove that an
argument-vector mismatch, owner-only state, malformed or foreign PID-only
state, and replaced owner or socket inodes remain untouched and cause no
signal. They MUST also prove that structurally valid dead residue is removed
only through captured inode identities. They MUST also prove the exact adjacent
`.service.sock.lease` path, public-socket/lease inode equality, unchanged exact
schema keys, triad ambiguity for every proper subset of owner, socket, and
lease artifacts, mismatch rejection, collision preservation, and exact dead
cleanup. All three artifacts absent MUST be verified as unowned. Inspection
MUST be verified to open the owner with `O_NOFOLLOW` and derive both owner
identity and bytes from that descriptor despite deterministic pathname
replacement.
Helper-level tests MUST enumerate all eight owner, socket, and lease presence
combinations. Integrated setup coverage across the existing split tests MUST
exercise every proper partial state. Inspection tests MUST require the strict
exact fingerprint shape with only `state`, `pid`, `startTicks`, `owner`, and
`socket` identities, and MUST prove exact retirement across an allowed
live-to-dead transition. Lifecycle tests MUST distinguish immutable
Project-root script provenance from process working directories: the service
owner MUST have `/tmp/dim-qemu-verification` as its stable working directory,
while the source root and launcher working directory remain `/workspace`.
Obsolete `service.pid` state MUST be
rejected without migration for both live and dead recorded processes. The
integrated enabled setup, disabled setup, and teardown paths MUST each reject
regular-file and symlink residue, for both live and dead recorded PIDs, before
lifecycle mutation while retaining the process and every artifact identity.

Publication tests MUST prove that the published owner has actual mode `0600`,
schema 1, and the launched PID; its recorded socket identity equals both the
actual public socket and lease; both socket paths have actual mode `0666`; and
no `service.pid` is created. Publication identity MUST come from the temporary
FileHandle, and identity-checked temporary cleanup MUST preserve a deterministic
replacement while closing the handle. Startup rollback
MUST cover owner-publication failure after socket bind while a foreign socket
replaces the bound pathname. Startup rollback and ordinary shutdown tests MUST
prove that the lease exists with the bound socket identity before blocked owner
publication and is removed after rollback, and that captured device and inode
identities prevent removal of a successor. The replacement test MUST retain the
old inode through its production lease. A separate deterministic test MUST keep
the original listener open across unlink and successor bind and prove that the
successor inode differs, rather than depending on allocator reuse behavior.
Restoration tests MUST prove that a later socket at the destination is not
overwritten and that both foreign socket inodes remain preserved. A direct
second service MUST fail without replacing the active socket, owner, or run
tree. Listen errors MUST roll back only prepared startup state. Errors emitted
after listen succeeds but before initialization completes MUST remain latched,
MUST be honored only after the bound socket has an identity-pinned lease, and
MUST drive complete ownership-safe rollback. Tests MUST prove that the
temporary initialization handler is replaced by one permanent runtime error
handler only after activation commits.

Publication fault tests MUST cover post-link directory sync, temporary unlink,
handle close, rollback, replacement, and collision. They MUST assert exact
quarantine bytes and identities, preserved replacement and collision evidence,
rollback of only the exact linked owner, and stable aggregate error order.

Filesystem tests MUST require a pre-existing, setup-created, real root:root
service directory with exact mode `0755`, including rejection of symlinks,
non-root uid or gid, and any special mode bit. They MUST cover existing or
symlink collisions independently at all four preflight paths: obsolete PID,
owner, public socket, and lease. They MUST prove that preparation preserves
stale runs, creates an adjacent root:root directory with exact mode `0700`
including no special bits, activates it only after publication, and discards
only prepared state on pre-activation rollback. Static policy tests MUST prove
both agent mount layers expose the namespace read-only and workspace creation,
setup, and discard acquire the workspace setup lock.
Activation tests MUST prove that status and run both return `503` while the
service is `starting`, before owner publication and prepared-runs activation
commit. They MUST prove exact stale canonical restoration after every
pre-commit fault. Post-commit recursive cleanup faults MUST be fatal while the
fresh canonical runs remain and exact old bytes and identities remain
quarantined under `runs.replaced-*`, with no partial evidence restored as
canonical.

Setup tests MUST prove exact live-owner retirement occurs before replacement,
exact dead residue can be removed, and the malformed, foreign, ambiguous,
PID-only, and argument-mismatched cases above fail closed. Readiness tests MUST
derive the actual owner PID independently of the wrapper and require its root
UID, owner mode exactly `0600`, public socket and lease modes exactly `0666`,
and a successful bounded status request. They MUST cover dead owners, malformed
owners, argument-vector mismatch, readiness failure after publication, owner
and socket replacement during readiness, and a started wrapper that never
publishes an owner. The no-owner case MUST reach a bounded failure without
signalling the wrapper, and every readiness replacement MUST remain untouched.
KVM-disabled setup coverage MUST prove the root-owned reset still runs through
the constrained elevated boundary.

Shutdown tests MUST cover an incomplete request body, incomplete raw HTTP
headers, an observed partial snapshot, and a running detached launcher group.
They MUST prove lease validation before close, admission closure, server close
initiation, `closeAllConnections`, awaited close, later-launch prevention, run
cleanup, and removal of only the service's own owner, socket, lease, and run
tree. They MUST prove normal lease removal, successor preservation after
replacement, and fail-closed pre-close behavior for missing or mismatched
leases. A deterministic lease collision MUST remain untouched and prevent
startup. Cancellation and shutdown tests MUST exercise repeated signals and
concurrent cancellation. They MUST use a TERM-ignoring launcher group and prove
bounded escalation from TERM to KILL, child closure, leader-exit descendant
cleanup, and complete group disappearance before snapshot deletion. A real
spawn `ENOENT` MUST finalize the run, release admission, clean its snapshot,
and permit re-admission. With an active launcher and invalid lease, tests MUST
prove launcher termination and run cleanup complete before the service exits
nonzero for the lease failure. A process-group residual after KILL MUST be
fatal, stop admission, close the listener while restoring the owned public
socket from its lease when the public pathname was not replaced, and preserve
exact owner, socket, lease, run, and snapshot evidence. Fatal listener close
MUST validate the lease before closing the server. With a valid owned lease and
a foreign public replacement, fatal close MUST preserve and restore the foreign
inode and reachability while retaining owner, lease, run, and snapshot
evidence. A rejected-run snapshot cleanup failure MUST be fatal, keep
admission closed, and retain the exact owner, socket, lease, run-tree, and
snapshot evidence without launching a child. Runtime listener errors MUST
be handled by the permanent handler after startup and MUST perform bounded
active-group termination before listener close while preserving evidence.
Cancellation-only process-group residuals and snapshot-removal failures MUST
also escalate finalization rejection into fatal shutdown rather than an HTTP
`400` response.

Shutdown serialization tests MUST prove that the first shutdown owner controls
cleanup. When graceful shutdown starts first, its cleanup MUST continue and a
later runtime error MUST reuse that work while upgrading the eventual exit to
`1`, without a competing listener close. When fatal shutdown starts first, it
MUST preserve evidence, and repeated runtime errors and later signals MUST
reuse the same bounded fatal shutdown and one listener close.
Run-finalization ordering tests MUST block snapshot removal deterministically
and prove both owners: fatal-first skips deletion and preserves the exact
snapshot, while ordinary-cleanup-first finishes its already-committed deletion,
then retains the active-run claim and all remaining evidence after a fatal
upgrade without claiming the deleting snapshot stayed intact.

Event tests MUST prove that no more than 16 followers are admitted for an
active run, follower 17 is rejected before successful stream headers, and a
closed follower releases capacity. A replay write that reports false MUST
immediately disconnect that follower instead of allowing unbounded
backpressure.

The agent may start, follow, inspect, or cancel the fixed launcher, but cannot
supply a command, launcher path, QEMU argument, or path outside the assembled
`/workspace`. Accepted `NAME=/workspace/PATH` inputs appear only as guest
snapshots under `/mnt/dim-inputs/NAME`. The service and QEMU process run in the
trusted workspace; `/dev/kvm`, QEMU binaries, the launcher copy, and its
base-image cache MUST NOT be mounted writable into the agent. Candidate
verification code executes only in the VM.

## Installer Facade Verification

`just verify mise-install-smoke` requires Docker and network access. It
verifies `mise use --raw --global 'npm:@slop-lab/dim-installer@<version>'` end to end in a
disposable container against a local npm registry seeded from freshly built
tarballs, covering facade-only vs. proxied `--help`/`--version`, the
mise-detected `--no-local-bin` default, and an explicit `--local-bin`
override. See [Installer Facade](14-installer-facade.md).
The local registry helper MUST execute the exact Verdaccio binary owned by the
frozen lockfile, bind a randomly selected IPv4 loopback port, close signup
after creating one random publisher, and require authentication for package
mutation.
Package tests must additionally cover the published launcher's direct use of
Node.js 24 or 26, its `mise exec node@24` fallback when the available Node.js
is absent or unsupported, npm `.bin` symlink resolution, argv preservation,
and its actionable failure when neither runtime path is available.

`just verify example BACKEND DIRTY external-urls` requires Docker with the
cgroup delegation needed by the nested workspace runtime. It proves
`examples/features/external-urls/README.md` end to end: a host DIM controller,
plugin loading before any external URL config exists, the example's checked-in
ingress and URL scripts, dnsmasq wildcard DNS, a project-root workspace,
the nested `dev` Compose service, a further `deep` container, root relay,
reverse proxy, ingress discovery, URL creation, HTTP access, and revocation.
The HTTP client runs on a separate Docker network, a loopback-only listener
must be unreachable from it, unknown and revoked routes must return 404, and
the controller-managed Caddy deployment must be generated and running without
an explicit setup command. Its private router port must not appear in the user
configuration.
It also reconciles an ingress through a local Cloudflare-compatible API,
resolves the resulting wildcard through authoritative CoreDNS, and verifies
provider cleanup without external credentials.
Host-side ingress configuration and inventory, route approval, and revocation
must run through the public `dim external-url` CLI rather than project-specific
curl wrappers. URL creation must run the checked-in host wrapper, which
dispatches `dim workspace exec WORKSPACE -- dim-development-service
request-url` into the workspace. The helper invocation receives only an
ingress, one or two container names, and a port; it must not receive workspace,
socket, token, domain, hostname, approval, or protocol selectors.

`just verify example BACKEND DIRTY multi-repository` requires Docker and managed Gitea. It
materializes the repositories under `examples/projects/multi-repository/repos/` in a temporary
directory and verifies the manifest-aware
`project create --bootstrap-git-url ... --apply-repos` flow,
protected refs, workspace, Project-owned agent, host Git identity, managed
repository access, nested Docker, and secret-bearing service boundary.

`just verify example BACKEND DIRTY single-repository` verifies the default
one-repository shape under `examples/projects/single-repository/`: no
`.dim/repos.yml`, no protected ref or secret service, a direct agent-style
push to `main`, explicit workspace resource limits, and an unprivileged
Project-owned agent serving the application through its private rootless DinD
sidecar boundary. It must also prove that the agent receives separate filtered
workspace-audience and agent-audience proxy sockets with only bodyless
self-restart and resource-read permissions respectively, cannot reach host
inputs through either, and can request an asynchronous restart of its own
workspace. The resource helper must use only the derived agent-audience socket;
the proxies must receive no host-admin authority and must reject a configuration
that combines the two audiences. Resource verification must use two
workspace grants with different assignments, prove that neither grant can name
or read the other workspace, prove that CPU `2.5` produces `dim-nproc` output
`2`, and prove that missing or unlimited CPU assignments fail instead of
falling back to host capacity. The
workspace/agent controller boundary must additionally prove that the agent
grant cannot authenticate to the workspace socket, the workspace grant cannot
authenticate to the agent socket, agent discovery omits restart and host
inputs, and an explicitly agent-audience External URL route remains usable.
The agent fixture must not mount the host-admin controller socket.
The smoke accepts `DIM_EXAMPLE_WORK_ROOT` so a remote or sibling DinD daemon can
resolve controller-socket bind sources through a shared absolute path.

`just verify example BACKEND DIRTY full-development-flow` verifies the
multi-repository reference Project and the complete stateful journey described
above. CI runner lifecycle remains separate because it is a Project-external
host capability rather than Project-owned development configuration.

## Documentation Verification

Controller API tests must cover command-session creation, ordered SSE replay,
stdout/stderr separation, input forwarding, completion, sanitized failures,
and cancellation. Linux process tests must exercise a real PTY, initial
terminal dimensions, live resize, input, output, and exit propagation; session
tests must prove that internal probe output is not emitted. CLI contract tests
must ensure `exec`, `run`, workspace
lifecycle, and CI runner log commands use the streaming controller client and
forward `SIGWINCH`, and that the obsolete `--processes` spelling is rejected in
favor of `--pids`.
Streaming tests MUST also send redirected and named-FIFO input through one
ordered input queue, including EOF, and prove that input responses, input and
event transports, event responses, cancellation requests, and local
interruption failures all surface to the caller.

The managed container-integration and full-development integration steps in
QEMU-backed lanes MUST exercise live PTY resize without an unsupported
override. Only the workflow step named `Verify source repository set` may
record `DIM_TEST_PTY_RESIZE=unsupported` as an observation of that source
lane's current environment. The observation is not evidence of a Sysbox
product limitation and MUST NOT weaken container or disposable-QEMU resize
verification.

For `CLI-WORKSPACE-IMAGE-STATUS-001`, CLI tests MUST verify the exact human and
JSON ready and missing output, including a
`sha256:<64 lowercase hexadecimal digits>` image ID in ready output and no
image ID in missing output. They MUST prove that non-absence inspection
failures remain errors and that status is independent of host readiness,
controller readiness, and workspace lifecycle state.

For `CLI-WORKSPACE-IMAGE-IDENTITY-001`, core tests MUST prove the release
package version supplies the default tag and that `DIM_WORKSPACE_IMAGE` wins.
Executable local-source tests MUST prove that every package tarball and the
local workspace image use exactly the same aggregate local version, including
the reviewed aggregate-lock digest. They MUST prove that local image
preparation is explicit and precedes use of the matching local packages, that
the release-tag build remains distinct, that no `latest` reference is used,
and that prepared state binds the shared local tag to the inspected immutable
image ID.

For `CLI-STREAM-PROGRESS-001`, CLI tests must prove that lifecycle and CI
streams show an idle spinner only on TTY stderr, retain deterministic Project
stage lines in non-TTY output, and emit no spinner or terminal-control bytes to
non-TTY output, JSON stdout, or interactive `exec` and `run` byte streams.
Workspace lifecycle tests must prove that entered fixed stages update the
current-stage row, guaranteed remaining milestones disappear when completed,
conditional stages appear only after their event, unknown stage text is not
rendered, and progress rows do not exceed the active terminal width. Real-PTY
verification must include wide-character output after a visible progress block.
Result, error, disconnect, cancellation, and local interruption must each clear
the complete progress block and leave no active timer or listener.

For `WORKSPACE-SSH-PROXY-001`, Project verification must connect through raw
stdio with no TTY, accept only key authentication after checking the generated
host-key fingerprint, and reconnect after agent recreation with persisted
authorized keys. It must prove that the target is fixed, no port is published,
and no host, trusted-workspace, or Project-runtime control socket is exposed.
Static checks MUST also prove that Project setup uses a bounded Compose wait
and that agent health requires the SSH server to accept a connection, so setup
cannot report completion before the proxy target is usable.
Static checks MUST require a standalone key-only server configuration with no
root login, password path, client environment import, or image-baked key. They
MUST require runtime host-key generation, persistent authorized keys, the fixed
`dim-agent` UID 1000, a fixed shell bridge, and a root-owned allowlisted
ephemeral environment outside the persistent home.

Live SSH checks MUST prove reads, writes, creation, and removal in both existing
and newly created workspace directories, equivalent operations in the agent
home, private rootless Docker use, and bounded Git credentials, identity,
no-prompt behavior, and safe directories limited to `/workspace` and
`/workspace/*`. They MUST exercise only the constrained External URL and QEMU
sockets, prove client `SetEnv` and `SendEnv` cannot override server values, and
prove that neither a host socket nor a Project-runtime socket is present.
Unprovisioned keys and password authentication MUST fail. The client MUST
attempt root authentication with the same known-valid key accepted for
`dim-agent`; root login MUST be rejected as account policy. A capable-host
journey missing `ssh` or `ssh-keygen` MUST report unavailable and exit `2`
before allocating state, not record passing evidence. QEMU service readiness
MUST be published only after its private socket has mode `0666` and the agent
receives that private namespace through a read-only mount.

When behavior changes:

- Update affected feature specs.
- Update local-details if command shapes, file formats, image entrypoints, or script behavior change.
- Update `docs/status.md` with new verified evidence.
- Ensure examples do not contradict protected-ref or secret-boundary invariants.
