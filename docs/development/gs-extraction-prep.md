# Git service extraction preparation

Base: approved development `c52eec55bbe29fe79b5f9a07db0dc081161a99a3`.
This is an in-monorepo preparation checkpoint, not a repository launch,
publication, deployment, or claim that every Git feature is extraction-ready.

## Observed dependency cuts

- Repository transport/storage primitives are Node-only, but their current
  public selectors expose DIM Project/workspace names. Protected-ref orchestration
  directly loads DIM activation/import proofs and format-12 SQLite records.
- The repository extension SDK imports the DIM control-plane framework; optional
  review, merge, PR, CI and sync plugins still depend on that SDK.
- Git-CI contracts depend on DIM execution contracts; scheduled tracing depends
  on DIM execution clients. CI does not require the PR plugin.
- The Native Git service client combines portable models with DIM operation,
  role-attestation and connection conventions. Host and Web packages are adapters.
- Six Git model/React libraries are already DIM-independent. The tracing
  evaluator is neutral except for its DIM runtime-registration wrapper.

## Implementation order

1. Establish the movable `packages/gs/*` owner with GS-only build configuration.
   Move the portable model/UI libraries and neutral tracing implementation to
   `@slop-lab/gs-*`; update consumers and artifact composition without aliases.
2. Move the existing repository initialization, executable verification, CGI
   backend, routing and atomic Git primitives into `gs-repository`. Public
   selectors use namespace/repository and principal identity, not DIM records.
   Keep a DIM translation boundary for existing Project/workspace interfaces.
3. Extract protected-ref ordering behind target-proof, durable-journal and
   policy-provider ports plus an explicit serialization boundary. Bind existing
   DIM proofs/state at the adapter; do not duplicate a scheduler or state engine.
4. Run a minimal GS HTTP composition outside DIM registration/activation with
   real Git reads/writes, protected-write denial and repository-scoped grants.
   Run existing DIM protected-ref, review, PR and sync regressions where affected.
5. Update ownership, package/build/install metadata and outcome-oriented release
   notes. Record exact remaining reverse dependencies rather than relabeling
   DIM-coupled packages as independent.

## Invariants and verification

- No GS source, type, runtime or build dependency on DIM packages/frameworks.
- Preserve existing receive-hook bytes and persisted digest/journal domains;
  those private storage markers are not permission to depend on DIM code.
- Preserve intent-before-CAS, exact candidate/tree/base/policy/issuer bindings,
  fail-closed required providers and recovery that never replays authorization.
- Standalone hosting does not imply standalone durable protected promotion:
  any missing independent journal implementation remains an explicit blocker.
- All test implementations stay in `tests/`; use disposable real Git/HTTP state,
  strict checks and package builds, not static import checks alone.
- No changes to prior worktrees, live services, credentials, runtime installation,
  protected refs, the installer facade or frozen CLI-host v1 fixtures.

## Delivered checkpoint

`packages/gs` now contains nine publishable `@slop-lab/gs-*` packages plus
private workspace/build tooling. The repository engine owns the actual Git
initialization, transport, integrity and atomic-update implementations. Public
selectors are namespace/repository keys and writer identities are principals.
The four DIM primitive files translate Project/workspace inputs inward; they
are not an alternative implementation of those Git algorithms.

Protected-ref ordering is shared through the GS target, journal and policy
ports. DIM supplies current activation/import/policy proof and translates intents
back into the unchanged format-12 JSON/digest. Existing serialized callers use
an explicit already-exclusive binding rather than reacquiring the DIM queue.
Tracking/evaluator contracts are GS-owned; the `dim.review-tracing.runtime`
registration port stays in the DIM tracing adapter. Scheduled execution still
uses the existing DIM task queue and lease client.

The whole copied GS subtree installs, builds and typechecks outside DIM. A
separate isolated repository package test performs real Git clone and ordinary
push, denies protected writes and cross-repository credentials, and rejects hook
and executable replacement. Its constructor creates no DIM registration,
activation or state database. These checks do not establish independent durable
promotion or independence of every existing optional service plugin.

## Exact remaining extraction blockers

| Boundary | Remaining dependency / owner action |
| --- | --- |
| Standalone durable promotion | GS has the CAS/recovery algorithm but no independent durable catalog/journal implementation. The current binding is `git-repositories/src/repository-cas.ts` into `repository-ref-state.ts`, import anchors and `bundle_activation`. A future GS owner must supply durable ports and chain validation, not reuse DIM's database format as its required runtime. |
| Optional service features | The DIM repository `/plugin-api` still imports `ControlPlaneExtension` and carries activation/lease context. Review, merge, PR, diff/blame service, comments, sync and Git-CI bindings still use that SDK. They have not been renamed as independent GS plugins. |
| Git contracts | `packages/contracts/git` mixes policy/ref models with DIM Project attachment and generation-bound HTTP admission. Split domain contracts from that transport before moving the package; a prefix-only rename would conceal coupling. |
| CI and execution | `packages/contracts/ci` and the DIM Git-CI implementation still use DIM execution schemas and evidence delivery. Scheduler leases, placement and runtime configuration remain DIM. A future typed check-provider adapter must preserve candidate/base/policy/issuer bindings. CI is not made dependent on PR by this checkpoint. |
| Caller API | `packages/service-clients/native-git` still combines DIM operations, private role connections, generation attestation and Git/CI views. The host/Web adapters remain DIM-owned consumers of GS models. |
| Synchronization | Git-owned fetch/proposal/publish logic still uses the DIM repository extension context. `.dim/repos.yml` parsing and Project mapping remain in the DIM host adapter; future GS sync configuration needs explicit translation, not a `.dim` reader. |
| Detector API naming | The Node evaluator runs without DIM code but still implements the canonical `dim:review` detector module and retains `dim-review-trace-*` / `dev.dim.review-tracing.owner` resource identities. These are not imports or forwarding aliases. Public API renaming and owned-resource transition are not claimed complete by this mechanical boundary extraction. |
| Deployment and artifact management | DIM admin/installer/deployment still own the Native Git service profile and selected plugin topology. Their source-bundle scripts explicitly map the aggregate artifact version to `GS_BUILD_VERSION`; GS itself has no DIM build dependency. No external repository or release was created. |

Independent packages form a dependency graph, not a mandatory ladder: diff and
blame models do not import discussions/review/CI; PR models depend on discussion
models but do not require a human-review or CI runtime. Existing DIM optional
composition tests continue to protect repository-only and review-without-CI
behavior while these larger adapter cuts remain visible.
